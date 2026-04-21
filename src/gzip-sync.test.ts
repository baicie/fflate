import { describe, it, expect } from "vitest";
import { gzipSync, strToU8 } from "./gzip-sync";

function decompressWithNode(data: Uint8Array): Uint8Array {
  const zlib = require("zlib") as typeof import("zlib");
  return new Uint8Array(
    zlib.gunzipSync(Uint8Array.from(data).buffer),
  );
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("gzipSync", () => {
  describe("basic functionality", () => {
    it("should produce valid GZIP format with correct magic bytes", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data);

      expect(compressed[0]).toBe(31); // GZIP magic byte 1
      expect(compressed[1]).toBe(139); // GZIP magic byte 2
      expect(compressed[2]).toBe(8); // Compression method (deflate)
    });

    it("should compress and decompress basic data correctly", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle empty data", () => {
      const data = new Uint8Array(0);
      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(decompressed.length).toBe(0);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("compression levels", () => {
    it("should work with level 0 (no compression)", () => {
      const data = new Uint8Array(100);
      for (let i = 0; i < 100; i++) data[i] = i;

      const compressed = gzipSync(data, { level: 0 });
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should work with level 9 (maximum compression)", () => {
      const data = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) data[i] = i % 256;

      const compressed = gzipSync(data, { level: 9 });
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should use default level 6 when not specified", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("options", () => {
    it("should handle mtime option", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const mtime = Date.now();
      const compressed = gzipSync(data, { mtime });

      expect(compressed.length).toBeGreaterThan(0);
      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle mtime of 0", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data, { mtime: 0 });

      expect(compressed.length).toBeGreaterThan(0);
      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle filename option", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data, { filename: "test.txt" });

      expect(compressed.length).toBeGreaterThan(0);
      expect(compressed[3]).toBe(8); // FNAME flag should be set
      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle empty filename", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data, { filename: "" });

      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle Date object for mtime", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const date = new Date();
      const compressed = gzipSync(data, { mtime: date });

      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle string mtime", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = gzipSync(data, { mtime: "2024-01-01" });

      const decompressed = decompressWithNode(compressed);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("data patterns", () => {
    it("should compress highly repetitive data effectively", () => {
      const data = new Uint8Array(10000);
      for (let i = 0; i < 10000; i++) data[i] = i % 10;

      const compressed = gzipSync(data, { level: 9 });
      const decompressed = decompressWithNode(compressed);

      expect(compressed.length).toBeLessThan(data.length);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle random data", () => {
      const data = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        data[i] = Math.floor(Math.random() * 256);
      }

      const compressed = gzipSync(data, { level: 6 });
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle all zeros data", () => {
      const data = new Uint8Array(5000);

      const compressed = gzipSync(data, { level: 9 });
      const decompressed = decompressWithNode(compressed);

      expect(compressed.length).toBeLessThan(data.length);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle data with all possible byte values", () => {
      const data = new Uint8Array(256);
      for (let i = 0; i < 256; i++) data[i] = i;

      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("large data", () => {
    it("should handle 100KB data", () => {
      const data = new Uint8Array(100000);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      const compressed = gzipSync(data, { level: 9 });
      const decompressed = decompressWithNode(compressed);

      expect(compressed.length).toBeLessThan(data.length);
      expect(arraysEqual(decompressed, data)).toBe(true);
    });

    it("should handle 1MB data", () => {
      const data = new Uint8Array(1024 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      const compressed = gzipSync(data, { level: 6 });
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("strToU8", () => {
    it("should convert ASCII string to Uint8Array", () => {
      const str = "Hello World";
      const result = strToU8(str);

      expect(result.length).toBe(str.length);
      for (let i = 0; i < str.length; i++) {
        expect(result[i]).toBe(str.charCodeAt(i));
      }
    });

    it("should convert UTF-8 string to Uint8Array", () => {
      const str = "Hello 你好 World";
      const result = strToU8(str);

      const expected = Buffer.from(str, "utf-8");
      expect(result.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(result[i]).toBe(expected[i]);
      }
    });

    it("should handle empty string", () => {
      const str = "";
      const result = strToU8(str);

      expect(result.length).toBe(0);
    });

    it("should handle latin1 mode", () => {
      const str = "Hello World";
      const result = strToU8(str, true);

      expect(result.length).toBe(str.length);
    });

    it("should handle complex UTF-8 characters", () => {
      const str = "🎉 emoji 🚀 and 中文";
      const result = strToU8(str);

      const expected = Buffer.from(str, "utf-8");
      expect(result.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(result[i]).toBe(expected[i]);
      }
    });

    it("should handle surrogate pairs correctly", () => {
      const str = "\uD83D\uDE80"; // Rocket emoji
      const result = strToU8(str);

      const expected = Buffer.from(str, "utf-8");
      expect(result.length).toBe(expected.length);
      expect(result.length).toBe(4);
    });
  });

  describe("gzipSync with strToU8", () => {
    it("should compress and decompress text string", () => {
      const str = "Hello World! This is a test.";
      const data = strToU8(str);
      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(Buffer.from(decompressed).toString()).toBe(str);
    });

    it("should compress and decompress Chinese text", () => {
      const str = "你好世界！这是一个测试。";
      const data = strToU8(str);
      const compressed = gzipSync(data);
      const decompressed = decompressWithNode(compressed);

      expect(Buffer.from(decompressed).toString()).toBe(str);
    });

    it("should compress and decompress mixed content", () => {
      const str = "Hello 世界! 123 🎉";
      const data = strToU8(str);
      const compressed = gzipSync(data, { level: 9 });
      const decompressed = decompressWithNode(compressed);

      expect(Buffer.from(decompressed).toString()).toBe(str);
    });
  });

  describe("dictionary support", () => {
    it("should handle dictionary option for compression", () => {
      const dictionary = strToU8("0123456789".repeat(100));
      const data = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) data[i] = i % 10;

      const compressed = gzipSync(data, {
        level: 9,
        dictionary,
      });
      const decompressed = decompressWithNode(compressed);

      expect(arraysEqual(decompressed, data)).toBe(true);
    });
  });

  describe("memory levels", () => {
    it("should work with different memory levels", () => {
      const data = new Uint8Array(10000);
      for (let i = 0; i < data.length; i++) data[i] = i % 256;

      for (let mem = 0; mem <= 12; mem++) {
        const compressed = gzipSync(data, {
          level: 6,
          mem: mem as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
        });
        const decompressed = decompressWithNode(compressed);

        expect(arraysEqual(decompressed, data)).toBe(true);
      }
    });
  });

  describe("integration with Node.js zlib", () => {
    it("should produce compatible output with Node zlib.gzipSync", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const zlib = require("zlib") as typeof import("zlib");

      const ourCompressed = gzipSync(data);
      const nodeCompressed = zlib.gzipSync(Uint8Array.from(data).buffer);

      const ourDecompressed = new Uint8Array(
        zlib.gunzipSync(Uint8Array.from(ourCompressed).buffer),
      );
      const nodeDecompressed = new Uint8Array(
        zlib.gunzipSync(nodeCompressed.buffer),
      );

      expect(arraysEqual(ourDecompressed, data)).toBe(true);
      expect(arraysEqual(nodeDecompressed, data)).toBe(true);
    });
  });
});
