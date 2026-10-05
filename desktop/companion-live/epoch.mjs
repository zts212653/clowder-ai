export class ConnectionEpoch {
  constructor() {
    this.value = 0;
    this.active = false;
  }
  begin() {
    this.active = true;
    return ++this.value;
  }
  end() {
    this.active = false;
    return ++this.value;
  }
  current(value) {
    return this.active && this.value === value;
  }
}
