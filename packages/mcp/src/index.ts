#!/usr/bin/env node
// MCP server over stdin/stdout, so nothing here may print to stdout except the protocol.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, readVersion } from './server.js';

await createServer(readVersion()).connect(new StdioServerTransport());
