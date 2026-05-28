import { defineConfig } from "vitest/config";
import * as fs from 'fs'
import * as path from 'path'

// 读取配置文件
function loadTestConfig() {
  try {
    const configPath = path.resolve(__dirname, 'test/.env')
    const configContent = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(configContent)
  } catch {
    return {}
  }
}

const testConfig = loadTestConfig()

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		env: {
			...testConfig,
		},
	},
});
