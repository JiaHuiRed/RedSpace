import { describe, expect, test } from "bun:test"
import { lazy } from "../../src/util/lazy"

describe("util.lazy", () => {
  test("should call function only once", () => {
    let callCount = 0
    const value = {}
    const getValue = () => {
      callCount++
      return value
    }

    const lazyValue = lazy(getValue)

    expect(callCount).toBe(0)

    expect(lazyValue()).toBe(value)
    expect(lazyValue()).toBe(value)
    expect(callCount).toBe(1)
  })
})
