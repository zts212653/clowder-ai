function validApplication(value) {
  return (
    value &&
    Object.keys(value).sort().join(',') === 'bundleId,name' &&
    typeof value.bundleId === 'string' &&
    /^[A-Za-z0-9.-]{1,255}$/.test(value.bundleId) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    [...value.name].length <= 128 &&
    !/[\p{Cc}\p{Cf}]/u.test(value.name)
  );
}
module.exports = { validApplication };
