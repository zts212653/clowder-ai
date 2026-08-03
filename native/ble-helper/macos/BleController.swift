import CoreBluetooth
import Darwin
import Foundation

final class BleController: NSObject, BleCommandHandling, CBCentralManagerDelegate, CBPeripheralDelegate {
    let writer: ProtocolWriter
    var central: CBCentralManager!
    var devices: [UUID: CBPeripheral] = [:]
    var activeScanSessionId: String?
    var scanTimeout: DispatchWorkItem?
    var operations: [UUID: DeviceOperation] = [:]

    init(writer: ProtocolWriter) {
        self.writer = writer
        super.init()
        central = CBCentralManager(
            delegate: self,
            queue: DispatchQueue.main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )
    }

    func handle(_ request: BleRequest) {
        switch request.command {
        case "scan.start": startScan(request)
        case "scan.stop": stopScan(request)
        case "device.inspect": beginDeviceOperation(request, kind: .inspect)
        case "gatt.read": beginDeviceOperation(request, kind: .read)
        case "device.disconnect": disconnect(request)
        case "helper.shutdown": shutdown(request)
        default: writer.error(requestId: request.requestId, code: "unsupported_command")
        }
    }

    private func startScan(_ request: BleRequest) {
        guard central.state == .poweredOn else {
            writer.error(requestId: request.requestId, code: "bluetooth_not_powered_on")
            return
        }
        guard activeScanSessionId == nil,
              let sessionId = boundedString(request.params["sessionId"], max: 128),
              let timeoutMs = boundedInt(request.params["timeoutMs"], min: 1, max: 30_000)
        else {
            writer.error(requestId: request.requestId, code: "invalid_or_active_scan")
            return
        }
        activeScanSessionId = sessionId
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        writer.response(requestId: request.requestId, data: ["started": true])
        writer.event(name: "scan.state", data: ["sessionId": sessionId, "state": "started"])
        let timeout = DispatchWorkItem { [weak self] in
            guard self?.activeScanSessionId == sessionId else { return }
            self?.finishScan(state: "timeout")
        }
        scanTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
    }

    private func stopScan(_ request: BleRequest) {
        guard let sessionId = boundedString(request.params["sessionId"], max: 128),
              sessionId == activeScanSessionId
        else {
            writer.error(requestId: request.requestId, code: "scan_session_mismatch")
            return
        }
        finishScan(state: "stopped")
        writer.response(requestId: request.requestId, data: ["stopped": true])
    }

    func finishScan(state: String) {
        guard let sessionId = activeScanSessionId else { return }
        central.stopScan()
        scanTimeout?.cancel()
        scanTimeout = nil
        activeScanSessionId = nil
        // Nearby, unbound peripherals are scan-session data. Retain only
        // devices with an operation in flight.
        for (identifier, peripheral) in devices where operations[identifier] == nil {
            if peripheral.state == .connected || peripheral.state == .connecting {
                central.cancelPeripheralConnection(peripheral)
            }
            devices.removeValue(forKey: identifier)
        }
        writer.event(name: "scan.state", data: ["sessionId": sessionId, "state": state])
    }

    private func beginDeviceOperation(_ request: BleRequest, kind: OperationKind) {
        guard central.state == .poweredOn,
              let deviceId = boundedString(request.params["deviceId"], max: 128),
              let uuid = UUID(uuidString: deviceId),
              let peripheral = resolvePeripheral(uuid)
        else {
            writer.error(requestId: request.requestId, code: "device_unavailable")
            return
        }
        guard operations[uuid] == nil else {
            writer.error(requestId: request.requestId, code: "device_busy")
            return
        }

        var serviceUuid: CBUUID?
        var characteristicUuid: CBUUID?
        if kind != .inspect {
            guard let service = boundedString(request.params["serviceUuid"], max: 64),
                  let characteristic = boundedString(request.params["characteristicUuid"], max: 64)
            else {
                writer.error(requestId: request.requestId, code: "invalid_gatt_target")
                return
            }
            serviceUuid = CBUUID(string: service)
            characteristicUuid = CBUUID(string: characteristic)
        }

        let operation = DeviceOperation(
            request: request,
            kind: kind,
            serviceUuid: serviceUuid,
            characteristicUuid: characteristicUuid
        )
        let timeout = DispatchWorkItem { [weak self] in
            self?.failOperation(uuid, code: "operation_timeout")
        }
        operation.timeout = timeout
        operations[uuid] = operation
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
        peripheral.delegate = self
        if peripheral.state == .connected {
            startDiscovery(for: peripheral)
        } else {
            central.connect(peripheral, options: nil)
        }
    }

    func startDiscovery(for peripheral: CBPeripheral) {
        guard let operation = operations[peripheral.identifier] else { return }
        if operation.kind == .inspect {
            peripheral.discoverServices(nil)
        } else if let serviceUuid = operation.serviceUuid {
            peripheral.discoverServices([serviceUuid])
        }
    }

    func completeInspection(_ peripheral: CBPeripheral) {
        guard let operation = operations[peripheral.identifier] else { return }
        let services = (peripheral.services ?? []).prefix(64).map { service -> [String: Any] in
            let characteristics = (service.characteristics ?? []).prefix(128).map { characteristic in
                [
                    "uuid": characteristic.uuid.uuidString,
                    "properties": propertyNames(characteristic.properties),
                ] as [String: Any]
            }
            return ["uuid": service.uuid.uuidString, "characteristics": characteristics]
        }
        writer.response(requestId: operation.request.requestId, data: ["services": services])
        clearOperation(peripheral.identifier)
        releasePeripheral(peripheral)
    }

    private func disconnect(_ request: BleRequest) {
        guard let deviceId = boundedString(request.params["deviceId"], max: 128),
              let uuid = UUID(uuidString: deviceId),
              let peripheral = resolvePeripheral(uuid)
        else {
            writer.error(requestId: request.requestId, code: "device_unavailable")
            return
        }
        clearOperation(uuid)
        if peripheral.state == .connected || peripheral.state == .connecting {
            central.cancelPeripheralConnection(peripheral)
        }
        devices.removeValue(forKey: uuid)
        writer.response(requestId: request.requestId, data: ["disconnected": true])
    }

    private func shutdown(_ request: BleRequest) {
        if activeScanSessionId != nil { finishScan(state: "stopped") }
        for operationId in operations.keys { clearOperation(operationId) }
        for peripheral in devices.values where peripheral.state == .connected || peripheral.state == .connecting {
            central.cancelPeripheralConnection(peripheral)
        }
        writer.response(requestId: request.requestId, data: ["stopping": true])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            Darwin.exit(0)
        }
    }

    private func resolvePeripheral(_ identifier: UUID) -> CBPeripheral? {
        if let existing = devices[identifier] { return existing }
        guard let retrieved = central.retrievePeripherals(withIdentifiers: [identifier]).first else { return nil }
        devices[identifier] = retrieved
        retrieved.delegate = self
        return retrieved
    }

    func failOperation(_ identifier: UUID, code: String) {
        guard let operation = operations[identifier] else { return }
        writer.error(requestId: operation.request.requestId, code: code)
        clearOperation(identifier)
        if let peripheral = devices[identifier] {
            releasePeripheral(peripheral)
        }
    }

    func clearOperation(_ identifier: UUID) {
        operations[identifier]?.timeout?.cancel()
        operations.removeValue(forKey: identifier)
    }

    func releasePeripheral(_ peripheral: CBPeripheral) {
        if peripheral.state == .connected || peripheral.state == .connecting {
            central.cancelPeripheralConnection(peripheral)
        }
        devices.removeValue(forKey: peripheral.identifier)
    }
}
