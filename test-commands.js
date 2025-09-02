#!/usr/bin/env node

// Simple test to verify our new push and pull commands exist
const { execSync } = require('child_process');

console.log('Testing pushwork CLI commands...');

try {
  // Test if pushwork help shows our new commands
  const helpOutput = execSync('node dist/cli.js --help', { encoding: 'utf8', cwd: __dirname });
  
  if (helpOutput.includes('push') && helpOutput.includes('pull')) {
    console.log('✅ Push and pull commands found in help output');
  } else {
    console.log('❌ Push or pull commands missing from help output');
  }
  
  // Test if push command exists
  try {
    execSync('node dist/cli.js push --help', { encoding: 'utf8', cwd: __dirname, stdio: 'pipe' });
    console.log('✅ Push command help accessible');
  } catch (error) {
    console.log('❌ Push command help failed:', error.message);
  }
  
  // Test if pull command exists
  try {
    execSync('node dist/cli.js pull --help', { encoding: 'utf8', cwd: __dirname, stdio: 'pipe' });
    console.log('✅ Pull command help accessible');
  } catch (error) {
    console.log('❌ Pull command help failed:', error.message);
  }

} catch (error) {
  console.log('❌ Failed to test commands:', error.message);
}
