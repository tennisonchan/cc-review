#!/usr/bin/env node
import { runMain } from "../review-loop-companion.mjs";

runMain(["result", ...process.argv.slice(2)]);
