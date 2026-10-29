import { describe, expect, test } from "bun:test"
import { extractGitCommits, tokenizeShell } from "../src/shell.js"
import { defaultConfig } from "../src/types.js"
import { validateGitCommits } from "../src/validator.js"

describe("tokenizeShell", () => {
  test("decodes Bash ANSI-C escapes and preserves unknown escapes", () => {
    const tokens = tokenizeShell(String.raw`$'core:\x20Subject\u0021\U0001F600\101\cA\e\E\a\b\f\n\r\t\v\\\'\"\?\z'`)

    expect(tokens[0]?.value).toBe("core: Subject!😀A\x01\x1b\x1b\x07\b\f\n\r\t\v\\'\"?\\z")
    expect(tokenizeShell(String.raw`$'core: \xC3\xA9\303\251'`)[0]?.value).toBe("core: éé")
    expect(tokenizeShell(String.raw`$'core: \xC3'$'\xA9'`)[0]?.value).toBe("core: é")
    expect(tokenizeShell(String.raw`$'core: Subject\0ignored'`)[0]?.value).toBe("core: Subject")
  })
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
      ["redirect", "2>&"],
      ["word", "1"],
    ])
    const invocations = extractGitCommits("git commit -m 'scope: fix' -s > /dev/null 2>&1")
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.messages).toEqual(["scope: fix"])
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
  })

  test("concatenates adjacent unquoted and quoted tokens", () => {
    const tokens = tokenizeShell('git commit --message="kernel: add foo" -s')
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "--message=kernel: add foo", "-s"])
  })
})

describe("extractGitCommits", () => {
  test("handles ANSI-C quotes and rejects ambiguous substitution syntax", () => {
    expect(extractGitCommits(String.raw`echo $(git commit -m "bad"; echo $'a\')')`)[0]?.messages).toEqual(["bad"])
    expect(() => extractGitCommits(`echo $(git commit -m "bad"; echo "\${x:-")'"}")`)).toThrow("double-quoted parameter expansion")
    expect(() => extractGitCommits(`echo "$(case x in x) git commit -m "bad"; echo "'" ;; esac)"`)).toThrow("case patterns inside a command substitution")
    expect(extractGitCommits('echo "$(echo "${HOME}")"; git commit -m "core: ordinary"')[0]?.messages).toEqual(["core: ordinary"])
    expect(extractGitCommits(String.raw`echo $(echo $'a\nb'); git commit -m "core: ordinary"`)[0]?.messages).toEqual(["core: ordinary"])
    expect(extractGitCommits('echo "$(printf %s case)"; git commit -m "core: ordinary"')[0]?.messages).toEqual(["core: ordinary"])
    expect(() => extractGitCommits('echo "$(if true; then case x in x) git commit -m bad;; esac; fi)"')).toThrow("case patterns inside a command substitution")
    expect(() => extractGitCommits('echo "$(function f { case x in x) git commit -m bad;; esac; }; f)"')).toThrow("function or coproc declarations inside a command substitution")
    expect(() => extractGitCommits('echo "$(coproc { case x in x) git commit -m bad;; esac; }; wait)"')).toThrow("function or coproc declarations inside a command substitution")
    expect(() => extractGitCommits('echo "$(time -p { case x in x) git commit -m bad;; esac; })"')).toThrow("case patterns inside a command substitution")
    expect(() => extractGitCommits('echo "$(time -p -- case x in x) git commit -m bad;; esac)"')).toThrow("case patterns inside a command substitution")
    expect(() => extractGitCommits('echo "$(time -- case x in x) git commit -m bad;; esac)"')).toThrow("case patterns inside a command substitution")
  })

  test("rejects nested quoting in double-quoted parameter expansions", () => {
    expect(() => extractGitCommits(`echo "\${x:-"'"}"; git commit -m "bad"`)).toThrow("double-quoted parameter expansion")
    expect(extractGitCommits('echo "${HOME}"; git commit -m "core: literal"')[0]?.messages).toEqual(["core: literal"])
    expect(tokenizeShell('echo "${x:-default}"')[1]?.value).toBe("${x:-default}")
  })

  test("keeps ANSI-C control escapes within their quote boundaries", () => {
    expect(extractGitCommits(String.raw`echo $'\c'; git commit -m "bad"`)[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits(String.raw`echo $'\c\\'; git commit -m "bad"`)[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits(String.raw`git commit -m $'core: a\nb'`)[0]?.messages).toEqual(["core: a\nb"])
    expect(tokenizeShell(String.raw`echo $'\c' $'\c\\'`).map((token) => token.value)).toEqual(["echo", "\\c", "\x1c"])
  })

  test("keeps attached braces and parameter expansions in their words", () => {
    expect(extractGitCommits('echo ${#x}; git commit -m "bad"')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('echo $(echo ${#x}; git commit -m "bad")')[0]?.messages).toEqual(["bad"])
    const commit = extractGitCommits('git commit -s -m "core: valid"{} --no-signoff --trailer "X: y" -F /etc/passwd')[0]
    expect(commit?.messages).toEqual(["core: valid{}"])
    expect(commit?.hasSignoffFlag).toBe(false)
    expect(commit?.hasTrailer).toBe(true)
    expect(commit?.filePaths).toEqual(["/etc/passwd"])
    expect(extractGitCommits('echo ${x}; { echo a; git commit -m "core: grouped"; }')[0]?.messages).toEqual(["core: grouped"])
    expect(extractGitCommits('echo { git commit -m bad }')).toEqual([])
    expect(extractGitCommits('bash -c \'function f { git commit -m bad; }; f\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('echo function f { git commit -m bad }')).toEqual([])
    expect(extractGitCommits('{\\\n git commit -m bad; }')[0]?.messages).toEqual(["bad"])
    expect(tokenizeShell('echo {\\\nattached}')[1]?.value).toBe("{attached}")
    expect(extractGitCommits('bash -c \'time -p { git commit -m bad; }\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('bash -c \'coproc { git commit -m bad; }; wait\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('bash -c \'coproc worker { git commit -m bad; }; wait\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('bash -c \'time -p ! { git commit -m bad; }\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('bash -c \'time -p -- { git commit -m bad; }\'')[0]?.messages).toEqual(["bad"])
    expect(extractGitCommits('bash -c \'time -- ! { git commit -m bad; }\'')[0]?.messages).toEqual(["bad"])
  })

  test("detects commands after every supported redirect form", () => {
    for (const redirect of [">123", "2>& 1", "2>&1", ">& 1", "&>out", "&>>out", "3>out", ">>out", "<in", "<<<text", "<>file", ">|out"]) {
      expect(extractGitCommits(`${redirect} git commit -m "bad"`)[0]?.messages).toEqual(["bad"])
    }
  })

  test("rejects expansions in message words without executing them", () => {
    for (const message of ["\"core: $(printf '%090d' 0)\"", '"core: `printf x`"', '"core: $VAR"', '"core: ${VAR}"', '"core: $((1+2))"', '"core: $[10**18]"', "core:$VAR", '--message="core: $VAR"', '-m"core: $VAR"']) {
      const command = `git commit -s ${message.startsWith("-") ? "" : "-m "}${message}`

      expect(() => validateGitCommits(extractGitCommits(command), defaultConfig, command)).toThrow("Cannot validate a message containing shell expansion. Supply the final message literally.")
    }

    for (const message of ["'core: $VAR'", "$'core: $(echo x)'", '"core: \\$VAR"']) {
      const command = `git commit -s -m ${message}`

      expect(() => validateGitCommits(extractGitCommits(command), defaultConfig, command)).not.toThrow()
    }
  })

  test("finds commits in backticks, substitutions, and literal shell -c bodies", () => {
    for (const command of ['echo `git commit -m "bad"`', 'echo "$(git commit -m bad)"', "bash -c 'git commit -m bad'", "sh -c 'git commit -m bad'", "zsh -c 'git commit -m bad'", "bash -lc 'git commit -m bad'", "bash -c -- 'git commit -m bad'", "bash -c -l 'git commit -m bad'", "bash -euo pipefail -c 'git commit -m bad'", "bash -o -c 'git commit -m bad'"]) {
      const invocations = extractGitCommits(command)

      expect(invocations).toHaveLength(1)
      expect(() => validateGitCommits(invocations, defaultConfig, command)).toThrow("Missing scope")
    }

    expect(() => extractGitCommits('bash -c "$SCRIPT"')).toThrow("Run git commit directly")
    expect(() => extractGitCommits("echo `git commit")).toThrow("Run git commit directly")
  })

  test("rejects unterminated quotes with the quote kind and opening position", () => {
    expect(() => tokenizeShell("echo 'x")).toThrow("Unterminated single quote starting at character 6. Close the quote before running the command.")
    expect(() => tokenizeShell('echo "x')).toThrow("Unterminated double quote starting at character 6. Close the quote before running the command.")
    expect(() => tokenizeShell("echo $'x")).toThrow("Unterminated ANSI-C quote starting at character 6. Close the quote before running the command.")
    expect(() => extractGitCommits("timeout 60 ssh host 'unterminated")).toThrow("Unterminated single quote")
  })

  test("does not execute tab-stripped heredoc bodies as commands", () => {
    expect(extractGitCommits('cat <<-EOF\n\tgit commit -m "bad"\n\tEOF\n')).toEqual([])
    expect(extractGitCommits("cat <<-'EOF'\n\tgit commit -m bad\n\tEOF\ngit commit -m 'core: actual' -s")[0]?.messages).toEqual(["core: actual"])
  })

  test("rejects --trailer in both forms without including raw trailer text", () => {
    for (const trailer of ['--trailer "Signed-off-by: Private <private@example.com>"', '--trailer="Signed-off-by: Private <private@example.com>"']) {
      const command = `git commit -m 'core: Subject' ${trailer}`

      try {
        validateGitCommits(extractGitCommits(command), defaultConfig, command)
        throw new Error("Expected rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(Error)

        if (error instanceof Error) {
          expect(error.message).toContain("Cannot validate --trailer")
          expect(error.message).not.toContain("private@example.com")
        }
      }
    }
  })
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

  test("identifies fixup flag from separate and joined long options", () => {
    const separate = extractGitCommits("git commit --fixup HEAD~2")
    expect(separate[0]?.isFixup).toBe(true)

    const joined = extractGitCommits("git commit --fixup=abc123")
    expect(joined[0]?.isFixup).toBe(true)

    const amend = extractGitCommits("git commit --fixup=amend:def456")
    expect(amend[0]?.isFixup).toBe(true)
  })

  test("parses options following separate and joined squash flag", () => {
    const separate = extractGitCommits('git commit --squash HEAD~3 -m "squash! scope: msg" -s')
    expect(separate[0]?.messages).toEqual(["squash! scope: msg"])
    expect(separate[0]?.hasSignoffFlag).toBe(true)

    const joined = extractGitCommits('git commit --squash=def456 -m "squash! scope: msg" -s')
    expect(joined[0]?.messages).toEqual(["squash! scope: msg"])
    expect(joined[0]?.hasSignoffFlag).toBe(true)
  })

  test("continues parsing flags after long options with joined arguments", () => {
    const invocations = extractGitCommits(
      'git commit --author="Dev <dev@example.com>" --cleanup=strip --fixup=HEAD -s',
    )

    expect(invocations[0]?.isFixup).toBe(true)
    expect(invocations[0]?.hasSignoffFlag).toBe(true)
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

    const dirFlag = extractGitCommits('git --git-dir=/repo/.git --work-tree=/repo commit -m "fs: fix leak" -s')
    expect(dirFlag).toHaveLength(1)
    expect(dirFlag[0]?.messages).toEqual(["fs: fix leak"])

    const separate = extractGitCommits('git --git-dir .git --work-tree . commit --amend --no-edit')
    expect(separate).toHaveLength(1)
    expect(separate[0]?.isAmend).toBe(true)
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

    for (const mutation of [
      "export GIT_DIR=/other/.git", "typeset -x GIT_DIR=/other/.git", "declare -x GIT_DIR=/other/.git",
      "source ./git-env.sh", ". ./git-env.sh", "eval 'export GIT_DIR=/other/.git'",
      "set -a; GIT_DIR=/other/.git; GIT_WORK_TREE=/other", "unset GIT_DIR", "readonly GIT_DIR=/other/.git",
    ]) {
      const changed = extractGitCommits(`${mutation}; git commit -m 'core: Update'`)

      expect(changed).toHaveLength(1)
      expect(changed[0]?.targetError).toContain("preceding directory or environment change")
    }
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
