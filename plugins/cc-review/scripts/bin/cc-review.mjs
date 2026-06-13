#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["review", ...process.argv.slice(2)]);
