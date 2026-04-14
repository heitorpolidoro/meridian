import { describe, it, expect } from 'vitest';
import { MockFileSystem } from '../mocks/MockFileSystem.ts';

describe('MockFileSystem', () => {
  it('should write and read files', () => {
    const fs = new MockFileSystem();
    fs.writeFile('test.txt', 'hello world');
    const content = fs.readFile('test.txt');
    expect(content).toBe('hello world');
  });

  it('should throw error when reading non-existent file', () => {
    const fs = new MockFileSystem();
    expect(() => fs.readFile('non-existent.txt')).toThrow('File not found');
  });

  it('should check if file exists', () => {
    const fs = new MockFileSystem();
    fs.writeFile('test.txt', 'hello world');
    expect(fs.exists('test.txt')).toBe(true);
    expect(fs.exists('non-existent.txt')).toBe(false);
  });

  it('should create directories and check existence', () => {
    const fs = new MockFileSystem();
    fs.mkdir('test-dir');
    expect(fs.exists('test-dir')).toBe(true);
  });

  it('should list directory contents', () => {
    const fs = new MockFileSystem();
    fs.mkdir('src');
    fs.writeFile('src/main.ts', 'console.log("hello")');
    fs.writeFile('src/utils.ts', 'export const a = 1');
    fs.mkdir('src/components');
    
    const contents = fs.readDirectory('src');
    expect(contents).toContain('main.ts');
    expect(contents).toContain('utils.ts');
    expect(contents).toContain('components');
  });

  it('should check if path is directory', () => {
    const fs = new MockFileSystem();
    fs.mkdir('src');
    fs.writeFile('src/main.ts', 'hello');
    expect(fs.isDirectory('src')).toBe(true);
    expect(fs.isDirectory('src/main.ts')).toBe(false);
  });

  it('should delete files', () => {
    const fs = new MockFileSystem();
    fs.writeFile('test.txt', 'hello');
    fs.deleteFile('test.txt');
    expect(fs.exists('test.txt')).toBe(false);
  });
});
