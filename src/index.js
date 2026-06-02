#!/usr/bin/env node
import { runCLI } from './cli.js';
import { startMCPServer } from './mcp-server.js';

const args = process.argv.slice(2);

if (args[0] === '--mcp') {
  startMCPServer().catch((err) => {
    console.error(`[ctx] MCP server error: ${err.message}`);
    process.exit(1);
  });
} else {
  runCLI(args).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
