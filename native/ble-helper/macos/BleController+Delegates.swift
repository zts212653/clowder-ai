import CoreBluetooth
import Foundation

extension BleController {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state: String
        switch central.state {
        case .poweredOn: state = "poweredOn"
        case .poweredOff: state = "poweredOff"
        case .unauthorized: state = "unauthorized"
        case .unsupported: state = "unsupported"
        case .resetting: state = "resetting"
        default: state = "unknown"
        }
        writer.event(name: "adapter.state", data: ["state": state])
        if central.state != .poweredOn, activeScanSessionId != nil {
            finishScan(state: "stopped")
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard let sessionId = activeScanSessionId else { return }
        devices[peripheral.identifier] = peripheral
        peripheral.delegate = self
        let advertisedServices = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let rawName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
        let name = rawName.map { String($0.prefix(128)) }
        let rssi = min(20, max(-127, RSSI.intValue))
        writer.event(name: "scan.discovered", data: [
            "sessionId": sessionId,
            "deviceId": peripheral.identifier.uuidString,
            "name": name ?? NSNull(),
            "rssi": rssi,
            "serviceUuids": advertisedServices.prefix(64).map(\.uuidString),
        ])
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        startDiscovery(for: peripheral)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        failOperation(peripheral.identifier, code: "connect_failed")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if operations[peripheral.identifier] != nil {
            failOperation(peripheral.identifier, code: "device_disconnected")
        }
        devices.removeValue(forKey: peripheral.identifier)
        writer.event(name: "device.disconnected", data: [
            "deviceId": peripheral.identifier.uuidString,
            "reason": error.map { String($0.localizedDescription.prefix(256)) } ?? NSNull(),
        ])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let operation = operations[peripheral.identifier] else { return }
        guard error == nil, let services = peripheral.services, services.count <= 64 else {
            failOperation(peripheral.identifier, code: "service_discovery_failed")
            return
        }
        switch operation.kind {
        case .inspect:
            operation.pendingServiceCount = services.count
            if services.isEmpty {
                completeInspection(peripheral)
                return
            }
            for service in services {
                peripheral.discoverCharacteristics(nil, for: service)
            }
        case .read:
            guard let target = operation.serviceUuid,
                  let service = services.first(where: { $0.uuid == target })
            else {
                failOperation(peripheral.identifier, code: "service_not_found")
                return
            }
            peripheral.discoverCharacteristics(operation.characteristicUuid.map { [$0] }, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let operation = operations[peripheral.identifier] else { return }
        guard error == nil, let characteristics = service.characteristics, characteristics.count <= 128 else {
            failOperation(peripheral.identifier, code: "characteristic_discovery_failed")
            return
        }
        if operation.kind == .inspect {
            operation.pendingServiceCount -= 1
            if operation.pendingServiceCount == 0 {
                completeInspection(peripheral)
            }
            return
        }
        guard let target = operation.characteristicUuid,
              let characteristic = characteristics.first(where: { $0.uuid == target })
        else {
            failOperation(peripheral.identifier, code: "characteristic_not_found")
            return
        }
        guard characteristic.properties.contains(.read) else {
            failOperation(peripheral.identifier, code: "characteristic_not_readable")
            return
        }
        peripheral.readValue(for: characteristic)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let operation = operations[peripheral.identifier], operation.kind == .read,
           characteristic.uuid == operation.characteristicUuid {
            guard error == nil, let value = characteristic.value, value.count <= bleMaxValueBytes else {
                failOperation(peripheral.identifier, code: "characteristic_read_failed")
                return
            }
            writer.response(requestId: operation.request.requestId, data: ["valueBase64": value.base64EncodedString()])
            clearOperation(peripheral.identifier)
            releasePeripheral(peripheral)
            return
        }
    }
}
