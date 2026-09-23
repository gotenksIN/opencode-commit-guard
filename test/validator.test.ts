import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultConfig } from "../src/types.js"
import { validateGitCommits } from "../src/validator.js"
import type { GitCommitInvocation } from "../src/types.js"

const testDir = join(import.meta.dir, ".validator-tmp")

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function invocation(
  messages: string[],
  hasSignoffFlag = true,
  filePaths: string[] = [],
  isAmend = false,
  isHelp = false,
): GitCommitInvocation {
  return {
    messages,
    filePaths,
    hasSignoffFlag,
    isAmend,
    isHelp,
  }
}

describe("validator - scope rules", () => {
  test("accepts standard scope in subject line", () => {
    const inv = [invocation(["kernel: add support for new soc"])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit -m '...' -s")).not.toThrow()
  })

  test("accepts scopes with hyphens, underscores, slashes, and dots", () => {
    const scopes = [
      "releasetools: fix ota generation",
      "device_xiaomi_sm8250: update tree",
      "build/soong: update ninja generator",
      "ext4: fix journal deadlock",
      "arm64: dts: update clock frequencies",
    ]

    for (const msg of scopes) {
      const inv = [invocation([msg])]
      expect(() => validateGitCommits(inv, defaultConfig, "git commit")).not.toThrow()
    }
  })

  test("accepts conventional commit scopes like feat(parser): and fix(ui):", () => {
    const inv1 = [invocation(["feat(parser): add subshell support"])]
    expect(() => validateGitCommits(inv1, defaultConfig, "git commit")).not.toThrow()

    const inv2 = [invocation(["fix(ui): resolve button alignment issue"])]
    expect(() => validateGitCommits(inv2, defaultConfig, "git commit")).not.toThrow()
  })

  test("accepts chained fixup and squash prefixes with standard and conventional scopes", () => {
    const subjects = [
      "fixup! kernel: fix race",
      "squash! releasetools: update ota",
      "fixup! feat(parser): add token",
      "fixup! squash! fix(ui): align button",
      "fixup! fixup! build: update task",
    ]

    for (const subject of subjects) {
      expect(() => validateGitCommits([invocation([subject])], defaultConfig, "git commit")).not.toThrow()
    }
  })

  test("rejects invalid fixup and squash subjects while preserving the full subject", () => {
    const invalidSubjects = [
      ["fixup! bad subject", "Missing scope in subject line"],
      ["squash! bad subject", "Missing scope in subject line"],
      ["fixup! bad@: subject", "Missing scope in subject line"],
      ["fixup! : empty scope", "Missing scope before colon"],
      ["squash! kernel:no space", "Missing space after colon"],
      ["fixup! kernel:", "Subject text after colon is empty"],
    ]

    for (const [subject, violation] of invalidSubjects) {
      if (subject === undefined || violation === undefined) continue

      expect(() => validateGitCommits([invocation([subject])], defaultConfig, "git commit")).toThrow(violation)
      expect(() => validateGitCommits([invocation([subject])], defaultConfig, "git commit")).toThrow(subject)
    }
  })

  test("rejects commit missing scope prefix", () => {
    const inv = [invocation(["Add support for new sensor"])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      'Missing scope in subject line "Add support for new sensor"',
    )
  })

  test("rejects commit with empty scope before colon", () => {
    const inv = [invocation([": add support for new sensor"])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      "Missing scope before colon",
    )
  })

  test("rejects commit with missing space after colon", () => {
    const inv = [invocation(["kernel:add support for new sensor"])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      "Missing space after colon",
    )
  })

  test("rejects commit with empty subject after colon", () => {
    const inv = [invocation(["kernel:"])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      "Subject text after colon is empty",
    )
  })

  test("allows commits without scope when requireScope is false", () => {
    const inv = [invocation(["Add freeform subject line"])]
    const config = { ...defaultConfig, requireScope: false }
    expect(() => validateGitCommits(inv, config, "git commit")).not.toThrow()
  })
})

describe("validator - allowed scopes", () => {
  const allowedConfig = {
    ...defaultConfig,
    allowedScopes: ["kernel", "releasetools", "build", "parser"],
  }

  test("accepts scope present in allowedScopes", () => {
    const inv = [invocation(["kernel: add support for foo"])]
    expect(() => validateGitCommits(inv, allowedConfig, "git commit")).not.toThrow()
  })

  test("accepts conventional commit whose inner scope is in allowedScopes", () => {
    const inv = [invocation(["feat(parser): add subshell tokenization"])]
    expect(() => validateGitCommits(inv, allowedConfig, "git commit")).not.toThrow()
  })

  test("rejects scope not present in allowedScopes", () => {
    const inv = [invocation(["networking: fix tcp buffer"])]
    expect(() => validateGitCommits(inv, allowedConfig, "git commit")).toThrow(
      'Scope "networking" is not in the allowed scopes list. Allowed scopes: kernel, releasetools, build, parser.',
    )
  })

  test("enforces allowedScopes when requireScope is false", () => {
    const inv = [invocation(["networking: fix tcp buffer"])]
    const config = { ...allowedConfig, requireScope: false }
    expect(() => validateGitCommits(inv, config, "git commit")).toThrow(
      'Scope "networking" is not in the allowed scopes list.',
    )
  })

  test("enforces allowedScopes for fixup and squash subjects", () => {
    expect(() => validateGitCommits(
      [invocation(["fixup! feat(parser): add token"])],
      allowedConfig,
      "git commit",
    )).not.toThrow()

    const subject = "squash! feat(networking): fix socket"
    expect(() => validateGitCommits(
      [invocation([subject])],
      allowedConfig,
      "git commit",
    )).toThrow('Scope "feat(networking)" is not in the allowed scopes list')
    expect(() => validateGitCommits(
      [invocation([subject])],
      allowedConfig,
      "git commit",
    )).toThrow(subject)
  })
})

describe("validator - line length limit", () => {
  test("accepts lines at or below 72 characters", () => {
    const subject = "kernel: add support for foo"
    const body = "This is a body paragraph that stays comfortably below the limit."
    const inv = [invocation([`${subject}\n\n${body}`])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).not.toThrow()
  })

  test("rejects subject line exceeding 72 characters", () => {
    const longSubject = "kernel: add support for an extremely long feature name that exceeds the limit"
    const inv = [invocation([longSubject])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      "exceeds maximum line length of 72 characters",
    )
  })

  test("rejects body line exceeding 72 characters and identifies line number", () => {
    const message = [
      "kernel: fix race condition",
      "",
      "Short explanation paragraph.",
      "This particular line has way too many words and stretches on and on past seventy-two columns.",
    ].join("\n")

    const inv = [invocation([message])]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(/Line 4 \(93 chars, max 72\)/)
  })

  test("allows disabling line length check with maxLineLength: 0", () => {
    const longMsg = "kernel: add very long feature ".repeat(5)
    const inv = [invocation([longMsg])]
    const config = { ...defaultConfig, maxLineLength: 0 }
    expect(() => validateGitCommits(inv, config, "git commit")).not.toThrow()
  })
})

describe("validator - signoff requirement", () => {
  test("accepts commit with signoff flag", () => {
    const inv = [invocation(["kernel: add foo"], true)]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).not.toThrow()
  })

  test("accepts commit with Signed-off-by trailer in body without -s flag", () => {
    const message = [
      "kernel: add foo",
      "",
      "Explanation text.",
      "",
      "Signed-off-by: Jane Doe <jane@example.com>",
    ].join("\n")

    const inv = [invocation([message], false)]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).not.toThrow()
  })

  test("rejects commit missing both signoff flag and trailer", () => {
    const inv = [invocation(["kernel: add foo"], false)]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit")).toThrow(
      "Missing commit signoff",
    )
  })

  test("rejects a signoff pattern used as the subject line", () => {
    const inv = [invocation(["Signed-off-by: Jane Doe <jane@example.com>"], false)]
    const config = { ...defaultConfig, requireScope: false }
    expect(() => validateGitCommits(inv, config, "git commit")).toThrow(
      "Missing commit signoff",
    )
  })

  test("rejects a signoff pattern after leading blank lines", () => {
    const inv = [invocation(["\nSigned-off-by: Jane Doe <jane@example.com>"], false)]
    const config = { ...defaultConfig, requireScope: false }
    expect(() => validateGitCommits(inv, config, "git commit")).toThrow(
      "Missing commit signoff",
    )
  })

  test("allows commit without signoff when the captured signing policy does not enforce it", () => {
    const inv = [invocation(["kernel: add foo"], false)]
    const config = { ...defaultConfig, enforceSignoff: false }
    expect(() => validateGitCommits(inv, config, "git commit")).not.toThrow()
  })

  test("enforces signoff requirements for explicit fixup and squash messages", () => {
    expect(() => validateGitCommits(
      [invocation(["fixup! kernel: fix race"], false)],
      defaultConfig,
      "git commit",
    )).toThrow("Missing commit signoff")
    expect(() => validateGitCommits(
      [invocation(["squash! kernel: fix race"], false)],
      defaultConfig,
      "git commit",
    )).toThrow("Missing commit signoff")
  })
})

describe("validator - file inputs and amend commits", () => {
  test("rejects message files without disclosing their content", () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, "commit_msg.txt")
    const secret = "private message content"
    writeFileSync(filePath, secret)
    const inv = [invocation([], true, [filePath])]
    let caught: Error | undefined

    try {
      validateGitCommits(inv, defaultConfig, "git commit -F ...")
    } catch (error) {
      if (error instanceof Error) caught = error
    }

    expect(caught?.message).toContain("Cannot validate a commit message from file")
    expect(caught?.message).toContain('git commit -s -m "kernel: add support for foo"')
    expect(caught?.message).not.toContain(secret)
  })

  test("allows fixup commits without an explicit message", () => {
    const inv = [{ ...invocation([], false), isFixup: true }]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit --fixup=HEAD")).not.toThrow()
  })

  test("allows no-edit amendments without reading repository history or message files", () => {
    const inv = [{ ...invocation([], false, [], true), hasNoEdit: true }]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit --amend --no-edit")).not.toThrow()
    expect(() => validateGitCommits(
      [{ ...invocation([], false, ["message.txt"], true), hasNoEdit: true }],
      defaultConfig,
      "git commit --amend --no-edit -F message.txt",
    )).toThrow(
      'Cannot validate a commit message from file "message.txt"',
    )
  })

  test("validates amend commits when new message is provided", () => {
    const invalidAmend = [invocation(["Missing scope on amend"], true, [], true)]
    expect(() => validateGitCommits(invalidAmend, defaultConfig, "git commit --amend -m ...")).toThrow(
      "Missing scope in subject line",
    )

    const validAmend = [invocation(["kernel: valid amended message"], true, [], true)]
    expect(() => validateGitCommits(validAmend, defaultConfig, "git commit --amend -m ...")).not.toThrow()
  })

  test("rejects non-amend commit with no message provided", () => {
    const inv = [invocation([], true)]
    expect(() => validateGitCommits(inv, defaultConfig, "git commit -s")).toThrow(
      "No commit message provided",
    )
  })
})

describe("validator - error message formatting", () => {
  test("formats comprehensive error with multiple violations and examples", () => {
    const badMessage = "bad subject without scope and stretching on way too long past seventy-two characters limit"
    const inv = [invocation([badMessage], false)]
    let caught: Error | undefined

    try {
      validateGitCommits(inv, defaultConfig, 'git commit -m "..."')
    } catch (err) {
      if (err instanceof Error) {
        caught = err
      }
    }

    expect(caught).toBeDefined()
    const errorText = caught?.message ?? ""
    expect(errorText).toContain("[commit-guard] Git commit rejected: commit message format rules violated.")
    expect(errorText).toContain("1. Missing scope in subject line")
    expect(errorText).toContain("2. Commit message exceeds maximum line length of 72 characters")
    expect(errorText).toContain("3. Missing commit signoff")
    expect(errorText).toContain("Example of a correctly formatted git commit:")
    expect(errorText).toContain('git commit -s -m "kernel: add support for foo"')
  })
})
