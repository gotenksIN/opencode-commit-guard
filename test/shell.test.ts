import { describe, expect, test } from "bun:test"
import { extractGitCommits, tokenizeShell } from "../src/shell.js"

describe("tokenizeShell", () => {
  test("tokenizes simple commands with whitespace", () => {
    const tokens = tokenizeShell("git commit -m 'first commit' -s")
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "first commit", "-s"])
  })

  test("handles single and double quotes with spaces", () => {
    const tokens = tokenizeShell('git commit -m "kernel: add support for foo" --signoff')
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "kernel: add support for foo", "--signoff"])
  })

  test("handles escaped quotes inside double quotes", () => {
    const tokens = tokenizeShell('git commit -m "parser: support \\"quoted\\" values" -s')
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", 'parser: support "quoted" values', "-s"])
  })

  test("handles ANSI-C quoting with escape sequences", () => {
    const tokens = tokenizeShell("git commit -m $'kernel: line 1\\nline 2' -s")
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "kernel: line 1\nline 2", "-s"])
  })

  test("handles line continuations with backslash newline", () => {
    const tokens = tokenizeShell("git commit \\\n  -m 'kernel: fix' \\\n  -s")
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "kernel: fix", "-s"])
  })

  test("discards line continuations inside double quotes", () => {
    const tokens = tokenizeShell('git commit -m "kernel: fix \\\nrace" -s')
    expect(tokens.map((token) => token.value)).toEqual(["git", "commit", "-m", "kernel: fix race", "-s"])
  })

  test("strips unquoted shell comments through the end of the line", () => {
    const tokens = tokenizeShell('git commit -m "kernel: fix" # --help -s\ngit status')
    expect(tokens.map((token) => token.value)).toEqual([
      "git",
      "commit",
      "-m",
      "kernel: fix",
      "\n",
      "git",
      "status",
    ])
  })

  test("handles chained operators and subshells", () => {
    const tokens = tokenizeShell("(cd repo && git commit -m 'docs: update' -s) || echo failed")
    expect(tokens.map((t) => t.value)).toEqual([
      "(",
      "cd",
      "repo",
      "&&",
      "git",
      "commit",
      "-m",
      "docs: update",
      "-s",
      ")",
      "||",
      "echo",
      "failed",
    ])
  })

  test("preserves control operators inside quotes without splitting", () => {
    const tokens = tokenizeShell('git commit -m "scope: handle foo && bar; test || check" -s')
    expect(tokens.map((t) => t.value)).toEqual([
      "git",
      "commit",
      "-m",
      "scope: handle foo && bar; test || check",
      "-s",
    ])
  })

  test("handles redirects and file descriptors", () => {
    const tokens = tokenizeShell("git commit -m 'scope: fix' -s > /dev/null 2>&1")
    expect(tokens.map((token) => [token.type, token.value])).toEqual([
      ["word", "git"],
      ["word", "commit"],
      ["word", "-m"],
      ["word", "scope: fix"],
      ["word", "-s"],
      ["redirect", ">"],
      ["word", "/dev/null"],
      ["redirect", "2>&1"],
    ])
    expect(extractGitCommits("git commit -m 'scope: fix' -s > /dev/null 2>&1")[0]).toEqual({
      messages: ["scope: fix"],
      filePaths: [],
      directoryChanges: [],
      hasSignoffFlag: true,
      isAmend: false,
      hasNoEdit: false,
      isHelp: false,
      unverifiableInputs: [],
    })
  })

  test("concatenates adjacent unquoted and quoted tokens", () => {
    const tokens = tokenizeShell('git commit --message="kernel: add foo" -s')
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "--message=kernel: add foo", "-s"])
  })
})

describe("extractGitCommits", () => {
  test("extracts standard git commit with -m and -s flags", () => {
    const invocations = extractGitCommits("git commit -m 'kernel: fix race' -s")
    expect(invocations).toHaveLength(1)
    const first = invocations[0]
    expect(first?.messages).toEqual(["kernel: fix race"])
    expect(first?.hasSignoffFlag).toBe(true)
    expect(first?.isAmend).toBe(false)
  })

  test("extracts combined short flags like -sm and -sam", () => {
    const invocations = extractGitCommits('git commit -sm "kernel: fix deadlock"')
    expect(invocations).toHaveLength(1)
    const first = invocations[0]
    expect(first?.messages).toEqual(["kernel: fix deadlock"])
    expect(first?.hasSignoffFlag).toBe(true)

    const sam = extractGitCommits('git commit -sam "kernel: fix race"')
    expect(sam).toHaveLength(1)
    expect(sam[0]?.messages).toEqual(["kernel: fix race"])
    expect(sam[0]?.hasSignoffFlag).toBe(true)
  })

  test("extracts combined short flag with adjacent message string", () => {
    const invocations = extractGitCommits('git commit -sm"kernel: fix adjacent" -a')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["kernel: fix adjacent"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
  })

  test("extracts multiple -m flags in order", () => {
    const invocations = extractGitCommits(
      'git commit -m "kernel: add foo" -m "Body paragraph 1" -m "Signed-off-by: Dev <dev@example.com>"',
    )

    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual([
      "kernel: add foo",
      "Body paragraph 1",
      "Signed-off-by: Dev <dev@example.com>",
    ])
    expect(invocations[0]?.hasSignoffFlag).toBe(false)
  })

  test("extracts long options --message and --signoff", () => {
    const invocations = extractGitCommits('git commit --signoff --message="releasetools: fix ota"')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["releasetools: fix ota"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
  })

  test("extracts -F and --file options", () => {
    const invocations = extractGitCommits("git commit -F commit_msg.txt -s")
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.filePaths).toEqual(["commit_msg.txt"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)

    const longOpt = extractGitCommits("git commit --file=/tmp/msg.txt --signoff")
    expect(longOpt).toHaveLength(1)
    expect(longOpt[0]?.filePaths).toEqual(["/tmp/msg.txt"])
  })

  test("extracts amend commits", () => {
    const amendNoEdit = extractGitCommits("git commit --amend --no-edit")
    expect(amendNoEdit).toHaveLength(1)
    expect(amendNoEdit[0]?.isAmend).toBe(true)
    expect(amendNoEdit[0]?.hasNoEdit).toBe(true)
    expect(amendNoEdit[0]?.messages).toHaveLength(0)

    const amendWithMessage = extractGitCommits('git commit --amend -m "kernel: amended msg" -s')
    expect(amendWithMessage).toHaveLength(1)
    expect(amendWithMessage[0]?.isAmend).toBe(true)
    expect(amendWithMessage[0]?.messages).toEqual(["kernel: amended msg"])
  })

  test("identifies git commit after leading environment variables", () => {
    const invocations = extractGitCommits('GIT_AUTHOR_NAME="Alice" git commit -m "build: fix" -s')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["build: fix"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
  })

  test("identifies git commit after command wrappers", () => {
    const invocations = extractGitCommits('env VAR=1 git commit -m "build: fix" -s')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["build: fix"])
  })

  test("handles global git flags preceding commit subcommand", () => {
    const invocations = extractGitCommits('git -C /path/to/repo commit -m "fs: fix leak" -s')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["fs: fix leak"])
    expect(invocations[0]?.directoryChanges).toEqual(["/path/to/repo"])

    const dirFlag = extractGitCommits('git --git-dir=/repo/.git --work-tree=/repo commit -m "fs: fix leak" -s')
    expect(dirFlag).toHaveLength(1)
    expect(dirFlag[0]?.messages).toEqual(["fs: fix leak"])
  })

  test("ignores non-commit git subcommands", () => {
    expect(extractGitCommits("git log --grep='commit'")).toHaveLength(0)
    expect(extractGitCommits("git status")).toHaveLength(0)
    expect(extractGitCommits("git commit-tree 123456")).toHaveLength(0)
    expect(extractGitCommits("git diff HEAD~1")).toHaveLength(0)
  })

  test("ignores commands that mention git commit as argument or string", () => {
    expect(extractGitCommits('echo "git commit -m \\"test\\""')).toHaveLength(0)
    expect(extractGitCommits('grep -rn "git commit" .')).toHaveLength(0)
  })

  test("extracts multiple git commits from chained commands", () => {
    const invocations = extractGitCommits(
      'git commit -m "scope1: first" -s && cd ../other && git commit -m "scope2: second" -s',
    )

    expect(invocations).toHaveLength(2)
    expect(invocations[0]?.messages).toEqual(["scope1: first"])
    expect(invocations[1]?.messages).toEqual(["scope2: second"])
  })

  test("handles positional arguments separator --", () => {
    const invocations = extractGitCommits('git commit -m "ui: update layout" -s -- src/index.ts')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["ui: update layout"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
  })

  test("handles --help flag", () => {
    const invocations = extractGitCommits("git commit --help")
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.isHelp).toBe(true)
  })

  test("does not parse flags inside shell comments", () => {
    const invocations = extractGitCommits('git commit -m "kernel: fix" # --help -s')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.isHelp).toBe(false)
    expect(invocations[0]?.hasSignoffFlag).toBe(false)
  })

  test("keeps escaped spaces inside substitution words", () => {
    const invocations = extractGitCommits('echo "$(printf %s foo\\ #bar)"; git commit -m bad')
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["bad"])
  })
})
