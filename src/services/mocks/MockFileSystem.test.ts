import { describe, it, expect, beforeEach } from 'vitest';
import { MockFileSystem } from './MockFileSystem';

describe('MockFileSystem', () => {
  let fs: MockFileSystem;

  beforeEach(() => {
    fs = new MockFileSystem();
  });

  it('should write and read files', () => {
    fs.writeFile('test.txt', 'hello');
    expect(fs.readFile('test.txt')).toBe('hello');
  });

  it('should throw error if file not found', () => {
    expect(() => fs.readFile('none.txt')).toThrow('File not found');
  });

  it('should append content to files', () => {
    fs.writeFile('test.txt', 'hello');
    fs.appendFile('test.txt', ' world');
    expect(fs.readFile('test.txt')).toBe('hello world');
  });

  it('should create new file on append if not exists', () => {
    fs.appendFile('new.txt', 'data');
    expect(fs.readFile('new.txt')).toBe('data');
  });

  it('should delete files', () => {
    fs.writeFile('test.txt', 'data');
    expect(fs.exists('test.txt')).toBe(true);
    fs.deleteFile('test.txt');
    expect(fs.exists('test.txt')).toBe(false);
  });

  it('should manage directories', () => {
    fs.mkdir('/test');
    expect(fs.isDirectory('/test')).toBe(true);
    expect(fs.exists('/test')).toBe(true);
  });

  it('should list directory contents', () => {
    fs.writeFile('/dir/file1.txt', '1');
    fs.writeFile('/dir/file2.txt', '2');
    fs.mkdir('/dir/subdir');
    
    const contents = fs.readDirectory('/dir');
    expect(contents).toContain('file1.txt');
    expect(contents).toContain('file2.txt');
    expect(contents).toContain('subdir');
  });
});
