import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeFileSystem } from './NodeFileSystem';
import fs from 'node:fs';

// Mock the entire fs module
vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    unlinkSync: vi.fn(),
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

  it('should call appendFileSync', () => {
    nfs.appendFile('test.txt', 'data');
    expect(fs.appendFileSync).toHaveBeenCalled();
  });

  it('should call unlinkSync in deleteFile only if file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    nfs.deleteFile('test.txt');
    expect(fs.unlinkSync).toHaveBeenCalledWith('test.txt');

    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    nfs.deleteFile('test.txt');
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('should call existsSync', () => {
    nfs.exists('test.txt');
    expect(fs.existsSync).toHaveBeenCalledWith('test.txt');
  });

  it('should call readdirSync in readDirectory', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['file1.txt'] as any);
    const result = nfs.readDirectory('dir');
    expect(fs.readdirSync).toHaveBeenCalledWith('dir');
    expect(result).toEqual(['file1.txt']);
  });

  it('should call statSync in isDirectory', () => {
    const isDirectoryMock = vi.fn().mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: isDirectoryMock } as any);
    
    const result = nfs.isDirectory('dir');
    expect(fs.statSync).toHaveBeenCalledWith('dir');
    expect(isDirectoryMock).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should call mkdirSync in mkdir', () => {
    nfs.mkdir('new-dir');
    expect(fs.mkdirSync).toHaveBeenCalledWith('new-dir', { recursive: true });
  });
});
