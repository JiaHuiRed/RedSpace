import { describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"
import { formatSdkSource, generateSdk } from "../../../sdk/js/script/codegen"
import { createOpencodeClient } from "@redcode-ai/sdk/v2/client"
import { tmpdir } from "../fixture/fixture"

const specFile = fileURLToPath(new URL("../../../sdk/openapi.json", import.meta.url))
const generated = fileURLToPath(new URL("../../../sdk/js/src/v2/gen/", import.meta.url))

async function sources(directory: string) {
  const result = new Map<string, string>()
  for await (const file of new Bun.Glob("**/*.ts").scan(directory)) {
    result.set(file.replaceAll("\\", "/"), await Bun.file(path.join(directory, file)).text())
  }
  return result
}

describe("API / OpenAPI / generated SDK contract", () => {
  test("generated SDK files match the committed OpenAPI spec", async () => {
    await using tmp = await tmpdir({ bare: true })
    const output = path.join(tmp.path, "gen")
    await generateSdk(specFile, output)
    const expected = await sources(output)
    for (const [file, source] of expected) {
      const filepath = path.join(generated, file)
      expected.set(file, await formatSdkSource(source, filepath))
    }
    expect(expected.has("sdk.gen.ts")).toBe(true)
    expect(await sources(generated)).toEqual(expected)
  })

  test("both generated config updates send the config argument as the JSON body", async () => {
    const sent: Array<{ path: string; body: unknown }> = []
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const request = new Request(input, init)
          const body: unknown = await request.json()
          sent.push({ path: new URL(request.url).pathname, body })
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        },
        { preconnect() {} },
      ),
    })
    const config = { model: "sdk-contract-test" }
    await client.config.update({ config }, { throwOnError: true })
    await client.global.config.update({ config }, { throwOnError: true })
    expect(sent).toEqual([
      { path: "/config", body: config },
      { path: "/global/config", body: config },
    ])
  })

})
