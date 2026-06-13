#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["setup", ...process.argv.slice(2)]);
