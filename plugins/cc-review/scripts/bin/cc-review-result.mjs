#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["result", ...process.argv.slice(2)]);
