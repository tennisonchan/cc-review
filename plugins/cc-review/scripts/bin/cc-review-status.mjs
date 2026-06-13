#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["status", ...process.argv.slice(2)]);
