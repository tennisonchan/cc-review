#!/usr/bin/env node
import { runMain } from "../review-loop-companion.mjs";

runMain(["setup", ...process.argv.slice(2)]);
