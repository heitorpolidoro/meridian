import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeFileSystem } from './NodeFileSystem';
import fs from 'node:fs';

// Mock the entire fs module
vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    mkdirSync: vi.fn()
  }
}));

describe('NodeFileSystem (Concrete)', () => {
  let nfs: NodeFileSystem;

  beforeEach(() => {
    vi.clearAllMocks();
    nfs = new NodeFileSystem();
  });

  it('should call readFileSync', () => {
    nfs.readFile('test.txt');
    expect(fs.readFileSync).toHaveBeenCalled();
  });

  it('should call writeFileSync', () => {
    nfs.writeFile('test.txt', 'data');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('should call existsSync', () => {
    nfs.exists('test.txt');
    expect(fs.existsSync).toHaveBeenCalled();
  });
});
