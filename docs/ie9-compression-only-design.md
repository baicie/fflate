# fflate GZIP 同步版 + IE9 Polyfill 方案设计

> 需求范围：**仅使用 `gzipSync` 和 `Gzip` 流式类**，删除其他一切代码。

## 一、背景

公司项目仅使用 fflate 的 `gzipSync` 同步压缩方法，无需异步、无需其他压缩格式、无需解压缩，且需兼容 IE9。fflate 原生使用大量 ES6+ / TypedArray 特性，不支持 IE9。

## 二、需求拆解

| 需求 | 说明 |
|------|------|
| GZIP 同步-only | 仅保留 `gzipSync`，删除 `gzip`/`AsyncGzip`/`Gzip` 类及其他一切 |
| IE9 兼容 | 补齐 IE9 缺失的 TypedArray / ES6 API |
| 性能 | 不作要求 |

## 三、精确代码清单

以下行号全部基于 `src/index.ts` 原始文件。

### 3.1 `gzipSync` 调用链追溯

```
gzipSync(data, opts)
    │
    ├── crc()              ──────── CRC32（GZIP 尾部校验必需）
    │       └── crct      ──────────── CRC32 查找表（line 758-766）
    │
    ├── dopt(data, opts, gzhl(opts), 8)
    │       ├── dflt()    ──────────── 核心 DEFLATE 压缩算法
    │       │       ├── fl / fd (Huffman base lookup)
    │       │       ├── revfl / revfd (Huffman reverse lookup)
    │       │       ├── rev (bit reverse table)
    │       │       ├── fleb / fdeb / clim (extra bits)
    │       │       ├── hMap() / hTree()
    │       │       ├── DeflateState
    │       │       ├── HuffNode
    │       │       ├── wbits / wbits16
    │       │       ├── lc / ln / clen
    │       │       ├── wfblk / wblk
    │       │       └── deo / et
    │       │
    │       └── u8 / u16 / i32 (TypedArray 别名)
    │
    ├── gzh()             ────────── 写 GZIP 头
    │
    ├── gzhl()            ────────── GZIP 头长度
    │
    └── wbytes()          ────────── 多字节写入（CRC32 + 长度写入）
```

### 3.2 必保留代码（精确到行）

#### A. TypedArray 别名 & 查找表（lines 1-121）

| 行号 | 内容 | 用途 |
|------|------|------|
| 1-12 | 注释 | — |
| 13 | `import wk from './node-worker'` | **删除**（不需要 worker） |
| 16 | `const u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array` | 类型别名 |
| 18-19 | `fleb`, `fdeb` | 固定长度/距离额外位数 |
| 25 | `clim` | 代码长度索引映射 |
| 28-41 | `freb()` | 生成 Huffman base/reverse 查找表 |
| 43-46 | `fl`, `revfl`, `fd`, `revfd` | 固定 Huffman 查找表 |
| 49-56 | `rev` | 16位反转表 |

> **精确确认：** `revfl` 和 `revfd` 在 `dflt()` 的 `hTree` 调用路径中被 `hMap` 使用。`fl` 和 `fd` 在 `wfblk`/`wblk` 中被直接使用。

#### B. hMap & 固定 Huffman 树（lines 58-121）

| 行号 | 内容 | 用途 |
|------|------|------|
| 61-121 | `hMap` 函数 + 固定 Huffman 树构建 | Huffman 编码核心 |
| 109-115 | 固定 Huffman 树（`fl`, `fd`, `revfl`, `revfd`） | 已在上表中定义 |

> `flm`, `flrm`, `fdm`, `fdrm`（lines 109-115）在 `gzipSync` 调用链中**未被直接使用**——它们是 `wblk` 中预计算的合并查找表，供动态 Huffman 使用。`gzipSync` 走的是 `dopt` → `dflt` 动态 Huffman 路径，这些固定合并表会被 `hTree` → `hMap` 动态生成，不依赖预计算值。

#### C. 位/字节工具（lines 122-154）

| 行号 | 内容 | 用途 |
|------|------|------|
| 124 | `const max = Math.max` | 性能优化 |
| 125-133 | `bits()`, `bits16()` | 位读取（解压用，`gzipSync` 不直接调用，但保留无害） |
| 134-141 | `shft()`, `slc()` | 字节对齐 + TypedArray 切片 |
| 143-154 | `max`, `bits`, `bits16`, `shft`, `slc` 导出别名 | 供 workerizer 用 |

#### D. 错误处理（lines 179-232）

| 行号 | 内容 | 用途 |
|------|------|------|
| 179-195 | `FlateErrorCode` | 错误码常量 |
| 197-203 | `ec` 错误消息数组 | 错误信息 |
| 205-217 | `FlateError` 类 | 错误类 |
| 219-232 | `err()` | 抛出错误的工厂函数 |

#### E. 核心 DEFLATE 压缩（lines 391-749）

| 行号 | 内容 | 用途 |
|------|------|------|
| 391-406 | `wbits()`, `wbits16()` | 位写入（`dflt` 中 `wfblk`/`wblk` 使用） |
| 408-417 | `HuffNode` 类型 | Huffman 树节点 |
| 420-489 | `hTree()` | 从频率表构建 Huffman 树 |
| 491-495 | `ln()` | 分配长度码 |
| 498-527 | `lc()` | 长度码生成 |
| 530-534 | `clen()` | 计算输出长度 |
| 538-548 | `wfblk()` | 写未压缩块 |
| 551-606 | `wblk()` | 写压缩块（Huffman 编码输出） |
| 608-609 | `deo` | DEFLATE 选项查找表 |
| 612 | `et`（empty typed array） | 空缓冲区占位 |
| 614-629 | `DeflateState` 类型 | 压缩状态机 |
| 632-749 | `dflt()` | **核心 DEFLATE 压缩算法** |

> **精确确认：** `wblk`（lines 551-606）中使用 `fl` / `fd`（base 查找表）和 `revfl` / `revfd`（reverse 查找表）。`hTree`（line 462）通过 `hMap(cd, mb, 0)` 调用 `revfl`/`revfd`。

#### F. CRC32 校验（lines 751-780）

| 行号 | 内容 | 用途 |
|------|------|------|
| 751-755 | `CRCV` 类型 | CRC32 accumulator 接口 |
| 758-766 | `crct` | CRC32 查找表（256 个 Int32） |
| 769-780 | `crc()` | **CRC32 计算（GZIP 尾部必需）** |

#### G. dopt — 带选项的 DEFLATE（lines 1005-1018）

| 行号 | 内容 | 用途 |
|------|------|------|
| 1005-1018 | `dopt()` | 带字典/级别选项的 DEFLATE，调用 `dflt()` |

#### H. GZIP 格式封装（lines 1187-1221）

| 行号 | 内容 | 用途 |
|------|------|------|
| 1178-1184 | `b2()`, `b4()`, `b8()` | 字节读取（GZIP 头解析用，仅解压需要，但保留无害） |
| 1187-1189 | `wbytes()` | **多字节写入（GZIP 头/尾必需）** |
| 1192-1200 | `gzh()` | **写 GZIP 头（magic + flags + mtime + OS）** |
| 1205-1212 | `gzs()` | GZIP 起始解析（解压用，可删除） |
| 1215-1218 | `gzl()` | GZIP 长度解析（解压用，可删除） |
| 1221 | `gzhl()` | **GZIP 头长度计算** |

> `gzs` 和 `gzl` 仅被解压代码（`Gunzip` 类）使用，可以删除，但保留它们代码量极小（~15 行）且不影响 `gzipSync` 的正确性。删除它们可以节省约 15 行。

#### I. gzipSync 快捷函数（lines 1738-1744）

| 行号 | 内容 | 用途 |
|------|------|------|
| 1738-1744 | `gzipSync()` | **唯一需要保留的导出函数** |

#### J. strToU8 工具（lines 2538-2676）

| 行号 | 内容 | 用途 |
|------|------|------|
| 2538 | `te` | TextEncoder 检测（GZIP 数据输入需要） |
| 2650-2676 | `strToU8()` | 字符串 → Uint8Array（将字符串数据转为二进制） |

> `td`（TextDecoder 检测，line 2540）和 `dututf8`（纯 JS UTF-8 解码，lines 2549-2564）是**解码**用的，GZIP 只写不读，全部删除。

#### K. GzipOptions 接口（lines 901-912）

| 行号 | 内容 | 用途 |
|------|------|------|
| 858-900 | `DeflateOptions` | 压缩级别/内存选项（GZIP 继承） |
| 901-912 | `GzipOptions` | **GZIP 特有选项（mtime, filename）** |

#### L. FlateError 类型（lines 179-232，已在 D 中）

### 3.3 需要删除的代码

| 类别 | 行号范围 | 行数 | 原因 |
|------|----------|------|------|
| Adler32 校验 | 783-802 | 20 | Zlib 用，GZIP 不需要 |
| Zlib 格式 | 1223-1240 | 18 | Zlib 用 |
| 解压接口 | 807-854 | ~50 | 解压相关 |
| 核心解压算法 `inflt` | 235-389 | 155 | 解压用 |
| `InflateState` 类型 | 156-174 | 19 | 解压用 |
| DEFLATE 解压类 `Inflate` | 1437-1586 | ~150 | 解压用 |
| DEFLATE 解压类 `AsyncInflate` | ~1586-1700 | ~114 | 解压用 |
| DEFLATE 快捷解压函数 | 1409-1435, 1560-1584 | ~60 | 解压用 |
| GUNZIP 解压类 `Gunzip` | 1755-1915 | ~160 | 解压用 |
| GUNZIP 解压类 `AsyncGunzip` | ~1915-2040 | ~125 | 解压用 |
| GUNZIP 快捷函数 | 1887-1915 | ~30 | 解压用 |
| `GunzipMemberHandler` 类型 | 1750 | 1 | 解压用 |
| ZLIB 压缩/解压 | 917, 1920-2209 | ~320 | 不需要 |
| 自动压缩/解压 | 2218-2385 | ~170 | 不需要 |
| ZIP 全部 | 2390-3778 | ~1390 | 不需要 |
| 字符串解码 | 2540, 2549-2698 | ~150 | GZIP 只写不读 |
| 目录展平 `fltn` | 2525-2535 | 11 | ZIP 用 |
| GZIP 解析函数 `gzs`/`gzl` | 1205-1218 | 14 | 仅解压用，可选删除 |
| `bits`/`bits16` 读取函数 | 125-141 | ~17 | 解压用（GZIP 只写不读） |
| `te`/`td` 检测后多余部分 | 2541-2564 | ~25 | TextDecoder 相关，GZIP 只写不需要 |
| Worker 相关 | 1020-1184 | ~165 | `mrg`, `wcln`, `wrkr`, `cbify`, `astrmify`, `astrm`, `bDflt`, `gze`, `pbf` |
| 异步类 | ~1340-1750 | ~410 | `AsyncDeflate`, `AsyncGzip`, `AsyncZlib`, `AsyncInflate`, `AsyncGunzip`, `AsyncUnzlib`, `AsyncDecompress` |
| 异步接口/类型 | 948-997 | ~50 | `AsyncFlateStreamHandler`, `AsyncFlateDrainHandler`, `FlateCallback`, `AsyncTerminable`, `AsyncOptions`, `Async*Options` |
| `StrmOpt` | 1242-1249 | 8 | 流选项处理（`Deflate`/`Gzip` 同步类用，但 `gzipSync` 直接调用不需要） |

### 3.4 精确行号汇总：gzipSync 调用链

| 行号 | 内容 | 是否需要 |
|------|------|----------|
| 1-12 | 文件头注释 | 保留 |
| 13 | `import wk from './node-worker'` | **删除** |
| 16 | TypedArray 别名 | 保留 |
| 18-19 | `fleb`, `fdeb` | 保留 |
| 25 | `clim` | 保留 |
| 28-41 | `freb()` | 保留 |
| 43-46 | `fl`, `revfl`, `fd`, `revfd` | 保留 |
| 49-56 | `rev` | 保留 |
| 58-121 | `hMap` + 固定树构建 | 保留 |
| 122-154 | 位/字节工具 | 保留 `slc`（必需），`shft`（必需），`max`（必需）；`bits`/`bits16` 读取可删 |
| 156-174 | `InflateState` | **删除** |
| 179-232 | 错误处理 | 保留 |
| 235-389 | `inflt()` | **删除** |
| 391-406 | `wbits`, `wbits16` | 保留 |
| 408-417 | `HuffNode` | 保留 |
| 420-489 | `hTree()` | 保留 |
| 491-548 | `ln`, `lc`, `clen`, `wfblk` | 保留 |
| 551-606 | `wblk()` | 保留 |
| 608-629 | `deo`, `et`, `DeflateState` | 保留 |
| 632-749 | `dflt()` | 保留 |
| 751-780 | CRC32 (`CRCV`, `crct`, `crc`) | 保留 |
| 783-802 | Adler32 | **删除** |
| 807-854 | 解压相关接口 | **删除** |
| 858-900 | `DeflateOptions` | 保留 |
| 901-912 | `GzipOptions` | 保留 |
| 917 | `ZlibOptions` | **删除** |
| 924-946 | `FlateStreamHandler`, `AsyncFlateStreamHandler`, `AsyncFlateDrainHandler`, `FlateCallback` | 保留 `FlateStreamHandler`；其余删除 |
| 948-997 | 异步接口/类 | **删除** |
| 1005-1018 | `dopt()` | 保留 |
| 1020-1184 | worker 相关 | **删除** |
| 1187-1189 | `wbytes()` | 保留 |
| 1178-1184 | `b2`, `b4`, `b8` | 可删（GZIP 只写不读），保留也可 |
| 1192-1200 | `gzh()` | 保留 |
| 1205-1218 | `gzs`, `gzl` | 可删（仅解压用） |
| 1221 | `gzhl()` | 保留 |
| 1223-1240 | Zlib 格式 | **删除** |
| 1242-1249 | `StrmOpt` | 可删（`gzipSync` 不走流式） |
| 1254-1338 | `Deflate` 类 | 可删（`gzipSync` 不走流式） |
| 1340-1750 | 异步类/函数 | **删除** |
| 1738-1744 | `gzipSync()` | **保留（唯一导出）** |
| 1750-3778 | 解压类、ZIP 类等 | **全部删除** |
| 2538-2539 | `te`, `td` | 保留 `te`；删除 `td` |
| 2541-2564 | TextDecoder 相关 | **删除** |
| 2650-2676 | `strToU8()` | 保留 |
| 2678-2698 | `strFromU8()` | **删除** |
| 其余 | `fltn`, ZIP 工具, dutf8 等 | **全部删除** |

### 3.5 预估代码量

| 项目 | 行数 |
|------|------|
| 查找表 + hMap | ~120 |
| 位/字节工具 | ~30 |
| 错误处理 | ~54 |
| 核心 DEFLATE（dflt + hTree + wblk 等） | ~370 |
| CRC32 | ~30 |
| dopt | ~14 |
| GZIP 格式（gzh + gzhl + wbytes） | ~25 |
| gzipSync | ~7 |
| strToU8 + te | ~140 |
| GzipOptions + DeflateOptions + FlateStreamHandler | ~100 |
| **合计** | **~890 行** |

| 项目 | 原始 | GZIP sync-only | 变化 |
|------|------|----------------|------|
| 源码行数 | 3779 | ~890 | **-76%** |
| 导出数量 | ~80 | 1 (`gzipSync`) | **-99%** |
| Bundle (minified, ES5) | ~8KB | ~3.5KB | **-56%** |

> 去掉 `Gzip` 流式类后代码量进一步减少约 300 行（Deflate 类 85 行 + Async 相关 200 行）。

## 四、方案设计

### 4.1 代码提取方案

从 `src/index.ts` 提取约 890 行 GZIP 同步压缩相关代码到 `src/gzip-sync.ts`。

#### 保留的文件结构

```
src/gzip-sync.ts
├── 注释头
├── TypedArray 别名
├── 查找表 (fleb, fdeb, clim, freb, fl, fd, revfl, revfd, rev)
├── hMap + 固定树
├── slc / shft / max
├── FlateErrorCode / FlateError / err()
├── wbits / wbits16
├── HuffNode
├── hTree / ln / lc / clen
├── wfblk / wblk
├── deo / et / DeflateState
├── dflt()
├── CRCV / crct / crc()
├── dopt()
├── wbytes / (b2/b4/b8 - 可选)
├── gzh / gzhl
├── DeflateOptions
├── GzipOptions
├── FlateStreamHandler
├── te
├── strToU8()
└── gzipSync()
```

#### 提取步骤

1. 创建 `src/gzip-sync.ts`
2. 按上表逐段提取，删除 `import wk`
3. 删除所有解压/ZIP/异步/Zlib 相关代码
4. 删除 `bits`/`bits16` 读取函数（`gzipSync` 不需要）
5. 删除 `td`/`dututf8`/`strFromU8`（GZIP 只写不读）
6. 删除 `gzs`/`gzl`（仅解压用）
7. 删除 `Deflate`/`Gzip` 流式类（`gzipSync` 直接调用，不需要）
8. 删除 `StrmOpt`（流式用）
9. 删除 `b2`/`b4`/`b8`（读函数，仅解压需要）
10. 验证 TypeScript 编译：`tsc --noEmit`

### 4.2 构建方案

#### 推荐：esbuild

```javascript
// build.mjs
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/gzip-sync.ts'],
  bundle: true,
  target: ['ie9'],
  outfile: 'dist/fflate-gzip-sync.min.js',
  format: 'iife',
  minify: true,
  logLevel: 'info',
});
```

```bash
npm install esbuild
node build.mjs
```

esbuild `target: ['ie9']` 自动注入：
- `Uint8Array` / `Uint16Array` / `Int32Array` / `ArrayBuffer` polyfill
- ES6 class → ES5 constructor function
- 箭头函数 → 普通函数
- `const`/`let` → `var`

#### 备选：TypeScript 原生

```json
// tsconfig.gzip.json
{
  "compilerOptions": {
    "target": "ES3",
    "lib": ["ES5", "DOM"],
    "outFile": "dist/fflate-gzip-sync.js",
    "downlevelIteration": true,
    "strict": false
  },
  "files": ["src/gzip-sync.ts"]
}
```

> TypeScript 原生方案只能处理语法转译（class → function），TypedArray polyfill 仍需单独引入。

## 五、Polyfill 详细方案

### 5.1 IE9 TypedArray Polyfill（最关键）

`gzipSync` 依赖的 TypedArray 操作：

| TypedArray 操作 | 使用场景 |
|----------------|----------|
| `new Uint8Array(len)` | 创建输出缓冲区（`dflt`、`gzh`、`wbytes`） |
| `new Uint16Array(len)` | Huffman base 查找表（`hMap`、`freb`） |
| `new Int32Array(len)` | CRC32 表、反转索引（`crct`、`revfd`） |
| `arr[i]` / `arr[i] = v` | 字节级读写（大量使用） |
| `arr.set(src, offset)` | 缓冲区复制（`dflt`、`gzh`） |
| `arr.subarray(i, j)` | 数据切片（`dopt` 字典处理） |
| `arr.buffer` | 获取底层 ArrayBuffer（`hMap` 中的 `b.buffer`） |
| `arr.byteOffset` / `arr.byteLength` | 元数据（`slc` 函数中） |

### 5.2 精简 Polyfill（手写版）

如不使用 esbuild，可独立引入以下 polyfill：

```javascript
// polyfill-typedarray.js
(function(g) {
  // ArrayBuffer
  if (!g.ArrayBuffer) {
    g.ArrayBuffer = function(l) { this.byteLength = l; };
    g.ArrayBuffer.prototype = {};
  }

  // Uint8Array
  if (!g.Uint8Array) {
    g.Uint8Array = function(a) {
      if (typeof a == 'number') {
        this.length = a;
        this.buffer = new g.ArrayBuffer(a);
      } else {
        a = a || [];
        this.length = a.length;
        this.buffer = new g.ArrayBuffer(a.length);
        for (var i = 0; i < a.length; i++) this[i] = a[i] || 0;
      }
      this.byteOffset = 0;
      this.byteLength = this.length;
    };
    g.Uint8Array.prototype = [];
  }

  // Uint16Array
  if (!g.Uint16Array) {
    g.Uint16Array = function(l) {
      this.length = l;
      this.buffer = new g.ArrayBuffer(l * 2);
      this.byteOffset = 0;
      this.byteLength = l * 2;
    };
    g.Uint16Array.prototype = [];
  }

  // Int32Array
  if (!g.Int32Array) {
    g.Int32Array = function(l) {
      this.length = l;
      this.buffer = new g.ArrayBuffer(l * 4);
      this.byteOffset = 0;
      this.byteLength = l * 4;
    };
    g.Int32Array.prototype = [];
  }

  // TypedArray prototype methods
  var proto = g.Uint8Array && g.Uint8Array.prototype;
  if (proto) {
    // set() - critical for dflt buffer operations
    proto.set = proto.set || function(src, offset) {
      offset = offset || 0;
      for (var i = 0; i < src.length; i++) this[i + offset] = src[i];
    };
    // subarray() - used in dopt dictionary handling
    proto.subarray = proto.subarray || function(s, e) {
      s = s || 0;
      e = e || this.length;
      var r = Object.create(g.Uint8Array.prototype);
      r.buffer = this.buffer;
      r.byteOffset = this.byteOffset + s;
      r.byteLength = e - s;
      r.length = e - s;
      return r;
    };
    // slice() - used in slc function
    proto.slice = proto.slice || function(s, e) {
      s = s || 0;
      e = e || this.length;
      var r = new g.Uint8Array(e - s);
      for (var i = s; i < e; i++) r[i - s] = this[i];
      return r;
    };
    // indexOf - used in crc32 loop
    proto.indexOf = proto.indexOf || function(v) {
      for (var i = 0; i < this.length; i++) if (this[i] === v) return i;
      return -1;
    };
  }

  // TextEncoder (needed by strToU8)
  if (!g.TextEncoder) {
    g.TextEncoder = function() {};
    g.TextEncoder.prototype.encode = function(s) {
      var r = [], i = 0, l = s.length, c;
      for (; i < l; i++) {
        c = s.charCodeAt(i);
        if (c < 128) r.push(c);
        else if (c < 2048) r.push(192 | (c >> 6), 128 | (c & 63));
        else r.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
      }
      return new g.Uint8Array(r);
    };
  }
})(typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global : this);
```

> 以上为示意代码，esbuild 自动处理方案更可靠。

## 六、最终产物

### 6.1 源码 API

```typescript
/**
 * Compresses data with GZIP
 * @param data The data to compress
 * @param opts The compression options
 * @returns The gzipped version of the data
 */
export function gzipSync(data: Uint8Array, opts?: GzipOptions): Uint8Array;

/**
 * Converts a string to a Uint8Array
 * @param str The string to convert
 * @param latin1 Whether to interpret as Latin-1
 */
export function strToU8(str: string, latin1?: boolean): Uint8Array;

export interface DeflateOptions {
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  mem?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  dictionary?: Uint8Array;
}

export interface GzipOptions extends DeflateOptions {
  mtime?: Date | string | number;
  filename?: string;
}

export const FlateErrorCode = { ... } as const;
export class FlateError extends Error { ... }
```

### 6.2 使用示例

```html
<!-- IE9 环境 -->
<script src="polyfill-typedarray.js"></script>
<script src="fflate-gzip-sync.min.js"></script>
<script>
  var data = strToU8("Hello World");
  var compressed = gzipSync(data, { level: 6 });
  // compressed 是一个 Uint8Array，可通过 Array.from(compressed) 获取字节数组
</script>
```

### 6.3 产物文件结构

```
dist/
├── fflate-gzip-sync.min.js   # ES5 + polyfill，单文件，IE9 直接用
└── fflate-gzip-sync.js       # ES5 + polyfill，未压缩（调试用）
```

## 七、风险与注意事项

1. **TypedArray polyfill 性能**：IE9 下 polyfill 性能极低，大文件压缩可能很慢，但公司项目不要求性能。

2. **`arr.buffer` 属性**：手写 polyfill 中 `Uint8Array.prototype` 需继承 `[]` 原型以支持索引访问，`buffer` 属性需显式设置。

3. **`slc` 函数依赖 `subarray` / `buffer` / `byteOffset`**：在 `gzipSync` 的 `strToU8`（line 2675）和 `dopt`（line 1009）中被调用。polyfill 需正确实现这些属性。

4. **GZIP 格式验证**：生成的 `.gz` 文件可用 `gunzip -t` 或浏览器 `DecompressionStream` 验证格式正确性。

5. **中文数据**：`strToU8` 在无原生 `TextEncoder` 时使用纯 JS UTF-8 编码，IE9 下正常工作。

6. **压缩级别**：`level` 参数传给 `dflt()`，IE9 下无特殊处理。

## 八、工作量估算

| 阶段 | 工作量 |
|------|--------|
| 代码提取（890 行筛选） | 0.5 天 |
| 构建配置（esbuild） | 0.5 天 |
| IE9 测试调优 | 1 天 |
| **合计** | **约 2 天** |
