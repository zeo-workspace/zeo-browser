// Real image bytes for the contract tests (story 045). Test support only.
// PNG_2X1 / JPEG_2X1 were produced with ImageMagick at authoring time; `png(w, h)` builds a real,
// decodable PNG of any size with node:zlib, so header-dimension checks are tested on true files.
import { crc32, deflateSync } from "node:zlib";

export const PNG_2X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURf8AABniCTcAAAAHdElNRQfqCgsBKTsSNREcAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTEwLTExVDAxOjQxOjU5KzAwOjAwbTHXaAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMC0xMVQwMTo0MTo1OSswMDowMBxsb9QAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTAtMTFUMDE6NDE6NTkrMDA6MDBLeU4LAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";
export const JPEG_2X1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A real RGB PNG of `w`×`h`; `padBytes` adds an ancillary chunk to grow the decoded size. */
export function png(w: number, h: number, padBytes = 0): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (padBytes > 0) {
    parts.push(chunk("zeRo", Buffer.alloc(padBytes)));
  }
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts).toString("base64");
}

/** The real 2×1 JPEG with its SOF0 dimensions rewritten to `w`×`h`. */
export function jpegClaiming(w: number, h: number): string {
  const bytes = Buffer.from(JPEG_2X1, "base64");
  const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  bytes.writeUInt16BE(h, sof + 5);
  bytes.writeUInt16BE(w, sof + 7);
  return bytes.toString("base64");
}
