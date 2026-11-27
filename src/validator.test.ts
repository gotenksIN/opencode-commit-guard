import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createTempRepo, expectThrows } from "../test/helpers.test-utils.js";
import { defaultConfig } from "./types.js";
import type { CommitGuardConfig, GitCommitInvocation } from "./types.js";
import { validateGitCommits } from "./validator.js";

const invocation = (
  messages: string[],
  overrides: Partial<GitCommitInvocation> = {}
) => ({
  messages,
  filePaths: [],
  hasSignoffFlag: true,
  isAmend: false,
  isHelp: false,
  ...overrides,
});

const validate = (
  message: string,
  config = defaultConfig,
  overrides: Partial<GitCommitInvocation> = {}
) => {
  validateGitCommits([invocation([message], overrides)], config);
};

const expectValidationError = (
  message: string,
  expected: string | RegExp,
  config = defaultConfig,
  overrides: Partial<GitCommitInvocation> = {}
) =>
  expectThrows(() => {
    validate(message, config, overrides);
  }, expected);

const allowedConfig: CommitGuardConfig = {
  ...defaultConfig,
  allowedScopes: ["kernel", "releasetools", "build", "parser"],
};

describe("validator contracts", () => {
  test.each([
    "releasetools: fix ota generation",
    "device_xiaomi_sm8250: update tree",
    "build/soong: update ninja generator",
    "ext4: fix journal deadlock",
    "arm64: dts: update clock frequencies",
    "feat(parser): add subshell support",
    "fix(ui): resolve button alignment issue",
    "fixup! kernel: fix race",
    "squash! releasetools: update ota",
    "fixup! feat(parser): add token",
    "fixup! squash! fix(ui): align button",
    "fixup! fixup! build: update task",
  ])(
    "accepts plain, conventional, and chained generated subjects: %s",
    (subject) => {
      expect(() => {
        validate(subject);
      }).not.toThrow();
    }
  );

  test.each([
    ["fixup! bad subject", "Missing scope in subject line"],
    ["squash! bad subject", "Missing scope in subject line"],
    ["fixup! bad@: subject", "Missing scope in subject line"],
    ["fixup! : empty scope", "Missing scope before colon"],
    ["squash! kernel:no space", "Missing space after colon"],
    ["fixup! kernel:", "Subject text after colon is empty"],
    [
      "Add support for new sensor",
      'Missing scope in subject line "Add support for new sensor"',
    ],
    [": add support for new sensor", "Missing scope before colon"],
    ["kernel:add support for new sensor", "Missing space after colon"],
    ["kernel:", "Subject text after colon is empty"],
  ])(
    "rejects malformed subjects without losing their text: %s",
    (subject, violation) => {
      expect(expectValidationError(subject, violation).message).toContain(
        subject
      );
    }
  );

  test.each([
    "kernel: add support for foo",
    "feat(parser): add subshell tokenization",
    "fixup! feat(parser): add token",
  ])("accepts allowed plain and conventional scopes: %s", (subject) => {
    expect(() => {
      validate(subject, allowedConfig);
    }).not.toThrow();
  });

  test("enforces the scope allowlist independently of requireScope", () => {
    expectValidationError(
      "networking: fix tcp buffer",
      'Scope "networking" is not in the allowed scopes list. Allowed scopes: kernel, releasetools, build, parser.',
      allowedConfig
    );
    expectValidationError(
      "networking: fix tcp buffer",
      'Scope "networking" is not in the allowed scopes list.',
      { ...allowedConfig, requireScope: false }
    );
    const subject = "squash! feat(networking): fix socket";
    expect(
      expectValidationError(
        subject,
        'Scope "feat(networking)" is not in the allowed scopes list',
        allowedConfig
      ).message
    ).toContain(subject);
  });

  test("supports scope, line length, and signing policy overrides", () => {
    expect(() => {
      validate("Add freeform subject line", {
        ...defaultConfig,
        requireScope: false,
      });
    }).not.toThrow();
    expect(() => {
      validate("kernel: add very long feature ".repeat(5), {
        ...defaultConfig,
        maxLineLength: 0,
      });
    }).not.toThrow();
    expect(() => {
      validate(
        "kernel: add foo",
        { ...defaultConfig, enforceSignoff: false },
        { hasSignoffFlag: false }
      );
    }).not.toThrow();
  });

  test("reports overlong body lines with their line number and length", () => {
    expectValidationError(
      [
        "kernel: fix race condition",
        "",
        "Short explanation paragraph.",
        "This particular line has way too many words and stretches on and on past seventy-two columns.",
      ].join("\n"),
      /Line 4 \(93 chars, max 72\)/u
    );
  });

  test("accepts a valid signoff trailer in the body without a flag", () => {
    expect(() => {
      validate(
        "kernel: add foo\n\nExplanation text.\n\nSigned-off-by: Jane Doe <jane@example.com>",
        defaultConfig,
        { hasSignoffFlag: false }
      );
    }).not.toThrow();
  });

  test.each([
    "kernel: add foo",
    "kernel: add foo\n\nſigned-off-by: Dev <dev@example.com>",
    "fixup! kernel: fix race",
    "squash! kernel: fix race",
  ])("requires an ASCII signoff flag or body trailer: %s", (message) => {
    expectValidationError(message, "Missing commit signoff", defaultConfig, {
      hasSignoffFlag: false,
    });
  });

  test.each([
    "Signed-off-by: Jane Doe <jane@example.com>",
    "\nSigned-off-by: Jane Doe <jane@example.com>",
  ])("does not treat a signoff subject as a trailer: %s", (message) => {
    expectValidationError(
      message,
      "Missing commit signoff",
      { ...defaultConfig, requireScope: false },
      { hasSignoffFlag: false }
    );
  });

  test("rejects message files without disclosing their contents", () => {
    const teardown: (() => void)[] = [];
    const directory = createTempRepo(teardown);
    const filePath = path.join(directory, "commit_msg.txt");
    const secret = "private message content";

    try {
      writeFileSync(filePath, secret);

      const error = expectThrows(() => {
        validateGitCommits(
          [invocation([], { filePaths: [filePath] })],
          defaultConfig,
          "git commit -F ..."
        );
      }, "Cannot validate a commit message from -F/--file before permission approval");

      expect(error.message).toContain(
        "git commit -s -m $'scope: Subject\\n\\nBody line one.\\nBody line two.'"
      );
      expect(error.message).not.toContain(secret);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each<Partial<GitCommitInvocation>>([
    { isFixup: true, hasSignoffFlag: false },
    { isAmend: true, hasNoEdit: true, hasSignoffFlag: false },
  ])("allows generated fixups and unchanged amendments: %j", (overrides) => {
    expect(() => {
      validateGitCommits([invocation([], overrides)], defaultConfig);
    }).not.toThrow();
  });

  test("rejects files even for no-edit amendments", () => {
    expectThrows(() => {
      validateGitCommits(
        [
          invocation([], {
            hasSignoffFlag: false,
            filePaths: ["message.txt"],
            isAmend: true,
            hasNoEdit: true,
          }),
        ],
        defaultConfig
      );
    }, "Cannot validate a commit message from -F/--file before permission approval");
  });

  test("validates explicit amendment messages and requires non-amend messages", () => {
    expectValidationError(
      "Missing scope on amend",
      "Missing scope in subject line",
      defaultConfig,
      { isAmend: true }
    );
    expect(() => {
      validate("kernel: valid amended message", defaultConfig, {
        isAmend: true,
      });
    }).not.toThrow();
    expectThrows(() => {
      validateGitCommits([invocation([])], defaultConfig);
    }, "No commit message provided");
  });

  test.each([true, false])(
    "formats examples from captured signing policy (%s)",
    (enforceSignoff) => {
      const error = expectThrows(() => {
        validateGitCommits(
          [invocation(["bad"], { hasSignoffFlag: false })],
          { ...defaultConfig, enforceSignoff, allowedScopes: ["core", "docs"] },
          "private attempted command"
        );
      });

      expect(error.message).toContain(
        enforceSignoff
          ? "Signoff required: captured commit.gpgsign=true. Keep -s."
          : "Signoff not required: captured commit.gpgsign=false|unset."
      );
      expect(error.message).toContain(
        `git commit${enforceSignoff ? " -s" : ""} -m $'core: Subject\\n\\nBody line one.\\nBody line two.'`
      );
      expect(error.message).not.toContain("private attempted command");
    }
  );

  test("orders multiple violations and supplies one example", () => {
    const error = expectValidationError(
      "bad subject without scope and stretching on way too long past seventy-two characters limit",
      "Git commit rejected",
      defaultConfig,
      { hasSignoffFlag: false }
    );

    for (const detail of [
      "[commit-guard] Git commit rejected: commit message format rules violated.",
      "1. Missing scope in subject line",
      "2. Commit message exceeds maximum line length of 72 characters",
      "3. Missing commit signoff",
      "Example:",
      "git commit -s -m $'scope: Subject\\n\\nBody line one.\\nBody line two.'",
    ]) {
      expect(error.message).toContain(detail);
    }
  });
});
