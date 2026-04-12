import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Bash } from '../../../agentfleet/tools/bash.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';

let tmpDir: string;
let bash: Bash;

beforeEach(() => {
  tmpDir = makeTempDir('bash-test');
  bash = new Bash(tmpDir);
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('Bash.run — safe commands', () => {
  it('returns output and exit code for echo', () => {
    const r = bash.run('echo hello');
    expect(r.output ?? r.stdout).toContain('hello');
    expect(r.error).toBeUndefined();
  });

  it('returns error for empty command', () => {
    expect(bash.run('').error).toBeDefined();
    expect(bash.run('   ').error).toBeDefined();
  });
});

describe('Bash.run — blocked patterns', () => {
  it('blocks path traversal (../)', () => {
    const r = bash.run('cat ../etc/passwd');
    expect(r.error).toBeDefined();
    expect(r.error).toContain('Path traversal');
  });

  it('blocks curl', () => {
    const r = bash.run('curl http://example.com');
    expect(r.error).toBeDefined();
    expect(r.error).toContain('Network tools');
  });

  it('blocks wget', () => {
    expect(bash.run('wget http://x.com').error).toBeDefined();
  });

  it('blocks sudo', () => {
    expect(bash.run('sudo ls').error).toContain('Privilege escalation');
  });

  it('blocks absolute paths', () => {
    const r = bash.run('cat /etc/passwd');
    expect(r.error).toBeDefined();
  });

  it('blocks $HOME', () => {
    expect(bash.run('ls $HOME').error).toBeDefined();
  });

  it('blocks tilde expansion', () => {
    expect(bash.run('ls ~/').error).toBeDefined();
  });

  it('blocks heredoc syntax', () => {
    expect(bash.run('cat <<EOF\nhello\nEOF').error).toBeDefined();
  });
});

describe('Bash readonly mode', () => {
  it('blocks write operations in readonly mode', () => {
    const roBash = new Bash(tmpDir, true);
    expect(roBash.run('echo x > file.txt').error).toBeDefined();
    expect(roBash.run('rm file.txt').error).toBeDefined();
    expect(roBash.run('touch newfile').error).toBeDefined();
  });

  it('allows read operations in readonly mode', () => {
    const roBash = new Bash(tmpDir, true);
    const r = roBash.run('echo hello');
    expect(r.error).toBeUndefined();
  });
});
