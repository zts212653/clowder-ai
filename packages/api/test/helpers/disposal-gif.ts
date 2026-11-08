/** A real three-frame GIF: full red, one blue pixel, then one green pixel.
 * Every pixel gets a clear code, keeping the fixture's LZW code width fixed at three bits.
 * Frame two either clears its rectangle (2) or restores the previous canvas (3).
 */
export function disposalGif(disposal: 2 | 3) {
  function lzw(pixels: number[]) {
    const codes = pixels.flatMap((pixel) => [4, pixel]).concat(5);
    const packed = Buffer.alloc(Math.ceil((codes.length * 3) / 8));
    codes.forEach((code, index) => {
      const bit = index * 3;
      packed[bit >> 3] |= (code << (bit % 8)) & 255;
      if (bit % 8 > 5) packed[(bit >> 3) + 1] |= code >> (8 - (bit % 8));
    });
    return Buffer.concat([Buffer.from([2, packed.length]), packed, Buffer.from([0])]);
  }
  function frame(left: number, pixels: number[], method: number, delay: number) {
    return Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, (method << 2) | 1, delay, 0, 0, 0]),
      Buffer.from([0x2c, left, 0, 0, 0, pixels.length, 0, 1, 0, 0]),
      lzw(pixels),
    ]);
  }
  return Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([2, 0, 1, 0, 0x81, 0, 0]),
    Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 0]),
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from('NETSCAPE2.0'),
    Buffer.from([3, 1, 0, 0, 0]),
    frame(0, [1, 1], 1, 5),
    frame(0, [2], disposal, 11),
    frame(1, [3], 1, 17),
    Buffer.from([0x3b]),
  ]);
}
