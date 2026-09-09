#!/usr/bin/env node

process.env["NODE_ENV"] = "production";
if (process.env["JARVIS_PORT"] !== undefined) process.env["PORT"] = process.env["JARVIS_PORT"];
await import("../dist/server/server/index.js");
