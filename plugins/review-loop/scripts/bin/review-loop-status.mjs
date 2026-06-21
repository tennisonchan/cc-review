#!/usr/bin/env node
import { runMain } from "../review-loop-companion.mjs";

runMain(["status", ...process.argv.slice(2)]);
