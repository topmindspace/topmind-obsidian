// Node builtins for the community review type-checker.
// That scan does not load @types/node, so fs/path/os/crypto/process otherwise
// collapse to an error type and trip no-unsafe-*. These are the calls the
// plugin actually makes. tsconfig "types": [] keeps @types/node from merging
// a second, conflicting copy over this file.

interface NodeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeStats {
  mtimeMs: number;
  mtime: Date;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeHash {
  update(data: string, encoding?: string): NodeHash;
  digest(encoding: "hex"): string;
}

declare module "node:fs" {
  export interface Dirent extends NodeDirent {}
  export interface Stats extends NodeStats {}
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  export function writeFileSync(path: string, data: string, encoding?: "utf8" | "utf-8"): void;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function statSync(path: string): Stats;
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): NodeHash;
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
  }
}

declare var process: NodeJS.Process;

declare function require(moduleName: string): unknown;
