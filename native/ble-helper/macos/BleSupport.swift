import CoreBluetooth
import Foundation

enum OperationKind {
    case inspect
    case read
}

final class DeviceOperation {
    let request: BleRequest
    let kind: OperationKind
    let serviceUuid: CBUUID?
    let characteristicUuid: CBUUID?
    var pendingServiceCount = 0
    var timeout: DispatchWorkItem?

    init(request: BleRequest, kind: OperationKind, serviceUuid: CBUUID? = nil, characteristicUuid: CBUUID? = nil) {
        self.request = request
        self.kind = kind
        self.serviceUuid = serviceUuid
        self.characteristicUuid = characteristicUuid
    }
}

func boundedString(_ value: Any?, max: Int) -> String? {
    guard let string = value as? String, !string.isEmpty, string.utf8.count <= max else { return nil }
    return string
}

func boundedInt(_ value: Any?, min: Int, max: Int) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.rounded(.towardZero) == number.doubleValue
    else { return nil }
    let intValue = number.intValue
    return intValue >= min && intValue <= max ? intValue : nil
}

func propertyNames(_ properties: CBCharacteristicProperties) -> [String] {
    var names: [String] = []
    if properties.contains(.read) { names.append("read") }
    if properties.contains(.notify) { names.append("notify") }
    if properties.contains(.indicate) { names.append("indicate") }
    if properties.contains(.write) { names.append("write") }
    if properties.contains(.writeWithoutResponse) { names.append("writeWithoutResponse") }
    return names
}
