import { describe, expect, test } from "bun:test";

import { extractGitCommits } from "./shell.js";
import { defaultConfig } from "./types.js";
import type { GitCommitInvocation } from "./types.js";
import { validateGitCommits } from "./validator.js";

const expectSingleCommit = (
  command: string,
  expected: Partial<GitCommitInvocation>
) => {
  const commits = extractGitCommits(command);
  expect(commits).toHaveLength(1);
  const [commit] = commits;

  if (commit === undefined) {
    throw new Error("Missing commit");
  }

  expect(commit).toMatchObject(expected);

  return commit;
};

const parseMessages = (command: string) =>
  expectSingleCommit(command, {}).messages;

describe("shell parsing through commit extraction", () => {
  test("decodes Bash ANSI-C escapes and preserves unknown escapes", () => {
    const commits = extractGitCommits(
      String.raw`git commit -m $'core:\x20Subject\u0021\U0001F600\101\cA\e\E\a\b\f\n\r\t\v\\\'\"\?\z'`
    );

    expect(commits[0]?.messages).toEqual([
      "core: Subject!😀A\u0001\u001B\u001B\u0007\b\f\n\r\t\v\\'\"?\\z",
    ]);
    expect(
      extractGitCommits(String.raw`git commit -m $'core: \xC3\xA9\303\251'`)[0]
        ?.messages
    ).toEqual(["core: éé"]);
    expect(
      extractGitCommits(String.raw`git commit -m $'core: \xC3'$'\xA9'`)[0]
        ?.messages
    ).toEqual(["core: é"]);
    expect(
      extractGitCommits(String.raw`git commit -m $'core: Subject\0ignored'`)[0]
        ?.messages
    ).toEqual(["core: Subject"]);
  });
  test.each([
    ["git commit -m 'first commit' -s", "first commit"],
    [
      'git commit -m "kernel: add support for foo" --signoff',
      "kernel: add support for foo",
    ],
    [
      'git commit -m "parser: support \\"quoted\\" values" -s',
      'parser: support "quoted" values',
    ],
    ["git commit \\\n  -m 'kernel: fix' \\\n  -s", "kernel: fix"],
    ['git commit -m "kernel: fix \\\nrace" -s', "kernel: fix race"],
    [
      "(cd repo && git commit -m 'docs: update' -s) || echo failed",
      "docs: update",
    ],
    [
      'git commit -m "scope: handle foo && bar; test || check" -s',
      "scope: handle foo && bar; test || check",
    ],
    ["git commit -m 'scope: fix' -s > /dev/null 2>&1", "scope: fix"],
    ['git commit --message="kernel: add foo" -s', "kernel: add foo"],
  ])(
    "preserves quoted words, operators, continuations, and redirects: %s",
    (command, message) => {
      expectSingleCommit(command, {
        messages: [message],
        hasSignoffFlag: true,
      });
    }
  );
});

describe("extractGitCommits", () => {
  test("skips literal heredoc bodies inside command substitutions", () => {
    for (const delimiter of ["'EOF'", '"EOF"', "E'OF'", "\\EOF", "EOF"]) {
      for (const body of [
        "the repository's style",
        "a ) b",
        "git commit -m bad",
      ]) {
        const command = `text=$(cat <<${delimiter}\n${body}\nEOF\n)`;

        expect(extractGitCommits(command)).toEqual([]);
      }
    }

    expect(
      extractGitCommits(
        "text=$(cat <<'EOF'\nthe repository's `style` $(git commit -m bad)\nEOF\n)\npayload=$(python3 -c 'pass' \"$text\")\nopencode api post /api/example --data \"$payload\""
      )
    ).toEqual([]);
    expect(extractGitCommits("text=$(cat <<''\na ) b\n\n)")).toEqual([]);
    expect(extractGitCommits('text=$(cat <<<"a ) b")')).toEqual([]);
  });

  test("queues multiple substitution heredocs and strips tabs only for <<-", () => {
    for (const delimiter of ["EOF", "'EOF'"]) {
      expect(
        extractGitCommits(
          `text=$(cat <<-${delimiter}\n\tthe repository's ) style\n\tEOF\n)`
        )
      ).toEqual([]);
    }

    expect(
      extractGitCommits(
        "text=$(cat <<'ONE' <<-TWO; echo ready\nthe repository's ) style\nONE\n\tmore ) text\n\tTWO\n)"
      )
    ).toEqual([]);
    expect(
      extractGitCommits("text=$(cat <<EOF \\\n; echo ready\na ) b\nEOF\n)")
    ).toEqual([]);
    expect(
      extractGitCommits("text=$(cat <<EOF # <<'ignored'\na ) b\nEOF\n)")
    ).toEqual([]);
    expect(() =>
      extractGitCommits("text=$(cat <<'EOF'\na ) b\n\tEOF\n)")
    ).toThrow("incomplete heredoc");
  });

  test("finds and validates commits inside substitutions containing heredocs", () => {
    for (const command of [
      "text=$(cat <<'EOF'\nthe repository's ) style\nEOF\ngit commit -m bad\n)",
      "text=$(cat <<EOF\na ) b $(git commit -m bad)\nEOF\n)",
      "text=$(cat <<EOF\n$(cat <<'INNER'\na ) b\nINNER\ngit commit -m bad\n)\nEOF\n)",
      "text=$(cat <<EOF\nE\\\nOF\ngit commit -m bad\n)",
    ]) {
      const invocations = extractGitCommits(command);

      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.messages).toEqual(["bad"]);
      expect(() => {
        validateGitCommits(invocations, defaultConfig, command);
      }).toThrow("Missing scope");
    }

    const command =
      "text=$(git commit -s -F - <<'EOF'\ncore: Preserve the repository's ) style\nEOF\n)";

    const invocations = extractGitCommits(command);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.stdinMessage).toBe(
      "core: Preserve the repository's ) style\n"
    );
    expect(() => {
      validateGitCommits(invocations, defaultConfig, command);
    }).not.toThrow();
  });

  test("preserves fail-closed inspection of unquoted substitution heredocs", () => {
    expect(() =>
      extractGitCommits("text=$(cat <<EOF\na ) b `git commit -m bad`\nEOF\n)")
    ).toThrow("command substitutions in an unquoted heredoc");
    expect(
      extractGitCommits(
        "text=$(cat <<EOF\na ) b \\$(git commit -m bad)\nEOF\n)"
      )
    ).toEqual([]);
    expect(
      extractGitCommits(
        "text=$(cat <<EOF\na ) b \\\\$(git commit -m bad)\nEOF\n)"
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        "text=$(cat <<EOF\nhello \\\nEOF\na ) b\nEOF\ngit commit -m bad\n)"
      )[0]?.messages
    ).toEqual(["bad"]);
  });

  test("rejects incomplete heredocs inside substitutions", () => {
    for (const command of [
      "text=$(cat <<'EOF'\na ) b\n)",
      "text=$(cat <<EOF\nthe repository's style\n)",
      "text=$(cat <<EOF)",
      "text=$(cat <<EOF",
      "text=$(cat <<'ONE' <<TWO\nbody\nONE\n)",
      "text=$(cat <<\n)",
    ]) {
      expect(() => extractGitCommits(command)).toThrow(
        "Cannot validate an incomplete heredoc. Close its delimiter on a separate line before running the command."
      );
    }
  });

  test("rejects dollar-quoted heredoc delimiters before skipping executable commands", () => {
    for (const quote of ['"', "'"]) {
      for (const continuation of ["", "\\\n"]) {
        const heredoc = `cat <<$${continuation}${quote}EOF${quote}\n"\nEOF\ngit commit -m bad\n$EOF\n`;

        const message =
          quote === '"'
            ? "locale-quoted heredoc delimiter"
            : "ANSI-C quoted heredoc delimiter";

        expect(() => extractGitCommits(heredoc)).toThrow(message);
        expect(() => extractGitCommits(`text=$(${heredoc})`)).toThrow(message);
      }
    }
  });

  test("does not interpret arithmetic left shifts as substitution heredocs", () => {
    for (const command of [
      "echo $((1 << 2))",
      'echo "$((1 << 2))"',
      "echo $( ((1 << 2)); echo done )",
    ]) {
      expect(extractGitCommits(command)).toEqual([]);
    }

    for (const command of [
      "echo $((1 << $(git commit -m bad)))",
      "echo $( ((1 << 2)); git commit -m bad )",
    ]) {
      expect(extractGitCommits(command)[0]?.messages).toEqual(["bad"]);
    }
  });

  test.each([
    '(( 1 << true ))\ngit commit -m "bypass"\ntrue',
    'echo "$( (( 1 << true ))\ngit commit -m "bypass"\ntrue )"',
    'for (( i=0; i<1; i+=1<<true )); do\ngit commit -m "bypass"\ndone\ntrue',
    'echo "$(for (( i=0; i<1; i+=1<<true )); do\ngit commit -m "bypass"\ndone\ntrue)"',
  ])("does not hide commits after arithmetic left shifts: %s", (command) => {
    expect(parseMessages(command)).toEqual(["bypass"]);
  });

  test.each([
    "cat <<\ngit commit -m bad",
    "cat <<",
    "cat <<EOF",
    "cat <<EOF\nbody",
  ])("rejects dangling top-level heredocs: %s", (command) => {
    expect(() => extractGitCommits(command)).toThrow("incomplete heredoc");
  });

  test("bounds substitution recursion through heredoc delimiters", () => {
    for (const command of [
      `echo $(${"cat <<$(".repeat(20_000)}true`,
      `${"cat <<$(".repeat(20_000)}true`,
    ]) {
      expect(() => extractGitCommits(command)).toThrow(
        "Shell parsing limit exceeded. Simplify the unsupported syntax."
      );
    }
  });

  test("joins unquoted heredoc continuations before delimiter matching", () => {
    const command = 'cat <<EOF\nhello \\\nEOF\n\'\nEOF\ngit commit -m "bad"';

    expect(extractGitCommits(command)[0]?.messages).toEqual(["bad"]);
    expect(
      extractGitCommits("git commit -F - <<'EOF'\nhello EOF\n'\nEOF\n")[0]
        ?.stdinMessage
    ).toBe("hello EOF\n'\n");
    expect(
      extractGitCommits('cat <<EOF\nE\\\nOF\ngit commit -m "bad"')[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        'cat <<EOF\nhello \\\\\nEOF\ngit commit -m "core: ordinary"'
      )[0]?.messages
    ).toEqual(["core: ordinary"]);
    expect(
      extractGitCommits("git commit -F - <<'EOF'\nhello \\\nEOF\n")[0]
        ?.stdinMessage
    ).toBe("hello \\\n");
    expect(
      extractGitCommits('cat <<EOF\n$(git commit -m "one \\\n two")\nEOF\n')[0]
        ?.messages
    ).toEqual(["one  two"]);
    expect(
      extractGitCommits(
        `cat <<EOF\n${"\\".repeat(3)}\n$(git commit -m bad)\nEOF\n`
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        `cat <<EOF\n${"\\".repeat(2)}$(git commit -m bad)\nEOF\n`
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("cat <<EOF\n\\$(git commit -m bad)\nEOF\n")
    ).toEqual([]);
  });

  test("rejects nonportable ANSI-C quoting in sh command bodies", () => {
    expect(() =>
      extractGitCommits(String.raw`sh -c "echo \$'\\\\'; git commit -m bad"`)
    ).toThrow("quoting portably in sh -c");
    expect(() =>
      extractGitCommits(
        String.raw`/bin/sh -c "echo \$'\\\\'; git commit -m bad"`
      )
    ).toThrow("quoting portably in sh -c");
    expect(
      extractGitCommits(
        `sh -c 'echo ordinary; git commit -m "core: ordinary"'`
      )[0]?.messages
    ).toEqual(["core: ordinary"]);

    for (const shell of ["bash", "zsh"]) {
      expect(
        extractGitCommits(`${shell} -c "git commit -m \\$'core: a\\\\nb'"`)[0]
          ?.messages
      ).toEqual(["core: a\nb"]);
    }
  });

  test("unescapes double quotes in double-quoted backtick substitutions", () => {
    expect(
      extractGitCommits('echo "`VAR=\\"\'\\" git commit -m \'bad\'`"')[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("echo `git commit -m 'core: ordinary'`")[0]?.messages
    ).toEqual(["core: ordinary"]);
    expect(
      extractGitCommits('echo "`git commit -m \\"core: ordinary\\"`"')[0]
        ?.messages
    ).toEqual(["core: ordinary"]);
  });

  test("handles ANSI-C quotes and rejects ambiguous substitution syntax", () => {
    expect(
      extractGitCommits(
        String.raw`echo $(git commit -m "bad"; echo $'a\')')`
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(`echo $(git commit -m "bad"; echo "\${x:-")'"}")`)[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        `echo "$(case x in x) git commit -m "bad"; echo "'" ;; esac)"`
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        `echo "$(echo "\${HOME}")"; git commit -m "core: ordinary"`
      )[0]?.messages
    ).toEqual(["core: ordinary"]);
    expect(
      extractGitCommits(
        String.raw`echo $(echo $'a\nb'); git commit -m "core: ordinary"`
      )[0]?.messages
    ).toEqual(["core: ordinary"]);
    expect(
      extractGitCommits(
        'echo "$(printf %s case)"; git commit -m "core: ordinary"'
      )[0]?.messages
    ).toEqual(["core: ordinary"]);
    expect(
      extractGitCommits(
        'echo "$(if true; then case x in x) git commit -m bad;; esac; fi)"'
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(() =>
      extractGitCommits(
        'echo "$(function f { case x in x) git commit -m bad;; esac; }; f)"'
      )
    ).toThrow("function or coproc declarations inside a command substitution");
    expect(() =>
      extractGitCommits(
        'echo "$(coproc { case x in x) git commit -m bad;; esac; }; wait)"'
      )
    ).toThrow("function or coproc declarations inside a command substitution");
    expect(
      extractGitCommits(
        'echo "$(time -p { case x in x) git commit -m bad;; esac; })"'
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        'echo "$(time -p -- case x in x) git commit -m bad;; esac)"'
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        'echo "$(time -- case x in x) git commit -m bad;; esac)"'
      )[0]?.messages
    ).toEqual(["bad"]);
  });

  test("preserves nested quoting in double-quoted parameter expansions", () => {
    expect(
      extractGitCommits(`echo "\${x:-"'"}"; git commit -m "bad"`)[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(`echo "\${HOME}"; git commit -m "core: literal"`)[0]
        ?.messages
    ).toEqual(["core: literal"]);
    expect(
      extractGitCommits(`git commit -m "\${x:-default}"`)[0]
    ).toMatchObject({ messages: [`\${x:-default}`], messageExpansion: true });

    for (const parameter of [
      `\${VAR:-"default"}`,
      `\${VAR:-"\${OTHER:-"default"}"}`,
      `\${VAR:-"a ) b"}`,
    ]) {
      expect(extractGitCommits(`printf %s "${parameter}"`)).toEqual([]);
      expect(
        extractGitCommits(`git commit -m "${parameter}"`)[0]
      ).toMatchObject({ messages: [parameter], messageExpansion: true });
      const command = `git commit -m "core: ${parameter}"`;
      expect(() => {
        validateGitCommits(extractGitCommits(command), defaultConfig, command);
      }).toThrow("shell expansion");
    }

    for (const parameter of [
      `\${VAR:-"$(git commit -m bad)"}`,
      `\${VAR:-\`git commit -m bad\`}`,
    ]) {
      expect(() => extractGitCommits(`printf %s "${parameter}"`)).toThrow(
        "Pre-execution shell inspection failed"
      );
    }
  });

  test("extracts and validates case branch commits inside substitutions", () => {
    for (const terminator of [";;", ";&", ";;&"]) {
      for (const pattern of [
        "x",
        "(x",
        "x|y",
        "x|esac",
        "\\x|esac",
        "\\\nx|esac",
        "in|esac",
        "(esac|x",
        '")"',
      ]) {
        const body = `case x in ${pattern}) git commit -m bad${terminator} y) printf ok;; esac`;
        const command = `printf %s "$(${body})"`;
        const invocations = extractGitCommits(command);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.messages).toEqual(["bad"]);
        expect(() => {
          validateGitCommits(invocations, defaultConfig, command);
        }).toThrow("Missing scope");
      }
    }

    expect(
      extractGitCommits('printf %s "$(case x in x) printf ok;; esac)"')
    ).toEqual([]);
    expect(
      extractGitCommits(
        'printf %s "$(case x in (x) case y in y) git commit -m bad;; esac;; esac)"'
      )[0]?.messages
    ).toEqual(["bad"]);
  });

  test("uses command-neutral pre-execution diagnostics for dynamic shell bodies", () => {
    for (const command of [
      'bash -c "$SCRIPT"',
      'bash -c "FOO=$BAR pytest"',
      "$COMMAND commit -m bad",
      `g\${X}it commit -m bad`,
    ]) {
      expect(() => extractGitCommits(command)).toThrow(
        "[commit-guard] Pre-execution shell inspection failed:"
      );
    }

    expect(() => extractGitCommits('bash -c "FOO=$BAR pytest"')).toThrow(
      "Use a literal shell body; if committing, run git commit directly."
    );
    expect(extractGitCommits("bash -c 'FOO=$BAR pytest'")).toEqual([]);
    expect(() => extractGitCommits("printf 'unterminated")).toThrow(
      "[commit-guard] Pre-execution shell inspection failed:"
    );
  });

  test("rejects expanded Git subcommands after global options", () => {
    for (const git of ["git", "/usr/bin/git"]) {
      for (const options of ["", "--no-pager ", "-- ", "--exec-path /bin "]) {
        expect(() =>
          extractGitCommits(
            `${git} ${options}"\${SUBCOMMAND:-"commit"}" -m bad`
          )
        ).toThrow("Pre-execution shell inspection failed");
      }
    }
  });

  test("keeps ANSI-C control escapes within their quote boundaries", () => {
    expect(
      extractGitCommits(String.raw`echo $'\c'; git commit -m "bad"`)[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(String.raw`echo $'\c\\'; git commit -m "bad"`)[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(String.raw`git commit -m $'core: a\nb'`)[0]?.messages
    ).toEqual(["core: a\nb"]);
    expect(
      extractGitCommits(String.raw`git commit -m $'\c' -m $'\c\\'`)[0]?.messages
    ).toEqual(["\\c", "\u001C"]);
  });

  test("keeps attached braces and parameter expansions in their words", () => {
    expect(
      extractGitCommits(`echo \${#x}; git commit -m "bad"`)[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(`echo $(echo \${#x}; git commit -m "bad")`)[0]?.messages
    ).toEqual(["bad"]);

    const [commit] = extractGitCommits(
      'git commit -s -m "core: valid"{} --no-signoff --trailer "X: y" -F /etc/passwd'
    );

    expect(commit?.messages).toEqual(["core: valid{}"]);
    expect(commit?.hasSignoffFlag).toBe(false);
    expect(commit?.hasTrailer).toBe(true);
    expect(commit?.filePaths).toEqual(["/etc/passwd"]);
    expect(
      extractGitCommits(
        `echo \${x}; { echo a; git commit -m "core: grouped"; }`
      )[0]?.messages
    ).toEqual(["core: grouped"]);
    expect(extractGitCommits("echo { git commit -m bad }")).toEqual([]);
    expect(
      extractGitCommits("bash -c 'function f { git commit -m bad; }; f'")[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(extractGitCommits("echo function f { git commit -m bad }")).toEqual(
      []
    );
    expect(
      extractGitCommits("{\\\n git commit -m bad; }")[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("git commit -m {\\\nattached}")[0]?.messages
    ).toEqual(["{attached}"]);
    expect(
      extractGitCommits("bash -c 'time -p { git commit -m bad; }'")[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("bash -c 'coproc { git commit -m bad; }; wait'")[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits(
        "bash -c 'coproc worker { git commit -m bad; }; wait'"
      )[0]?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("bash -c 'time -p ! { git commit -m bad; }'")[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("bash -c 'time -p -- { git commit -m bad; }'")[0]
        ?.messages
    ).toEqual(["bad"]);
    expect(
      extractGitCommits("bash -c 'time -- ! { git commit -m bad; }'")[0]
        ?.messages
    ).toEqual(["bad"]);
  });

  test("detects commands after every supported redirect form", () => {
    for (const redirect of [
      ">123",
      "2>& 1",
      "2>&1",
      ">& 1",
      "&>out",
      "&>>out",
      "3>out",
      ">>out",
      "<in",
      "<<<text",
      "<>file",
      ">|out",
    ]) {
      expect(
        extractGitCommits(`${redirect} git commit -m "bad"`)[0]?.messages
      ).toEqual(["bad"]);
    }
  });

  test("rejects expansions in message words without executing them", () => {
    for (const message of [
      "\"core: $(printf '%090d' 0)\"",
      '"core: `printf x`"',
      '"core: $VAR"',
      `"core: \${VAR}"`,
      '"core: $((1+2))"',
      '"core: $[10**18]"',
      "core:$VAR",
      '--message="core: $VAR"',
      '-m"core: $VAR"',
    ]) {
      const command = `git commit -s ${message.startsWith("-") ? "" : "-m "}${message}`;

      expect(() => {
        validateGitCommits(extractGitCommits(command), defaultConfig, command);
      }).toThrow(
        "Cannot validate a message containing shell expansion. Supply the final message literally."
      );
    }

    for (const message of [
      "'core: $VAR'",
      "$'core: $(echo x)'",
      '"core: \\$VAR"',
    ]) {
      const command = `git commit -s -m ${message}`;

      expect(() => {
        validateGitCommits(extractGitCommits(command), defaultConfig, command);
      }).not.toThrow();
    }
  });

  test("finds commits in backticks, substitutions, and literal shell -c bodies", () => {
    for (const command of [
      'echo `git commit -m "bad"`',
      'echo "$(git commit -m bad)"',
      "bash -c 'git commit -m bad'",
      "sh -c 'git commit -m bad'",
      "zsh -c 'git commit -m bad'",
      "bash -lc 'git commit -m bad'",
      "bash -c -- 'git commit -m bad'",
      "bash -c -l 'git commit -m bad'",
      "bash -euo pipefail -c 'git commit -m bad'",
      "bash -o -c 'git commit -m bad'",
    ]) {
      const invocations = extractGitCommits(command);

      expect(invocations).toHaveLength(1);
      expect(() => {
        validateGitCommits(invocations, defaultConfig, command);
      }).toThrow("Missing scope");
    }

    expect(() => extractGitCommits('bash -c "$SCRIPT"')).toThrow(
      "if committing, run git commit directly"
    );
  });

  test("explains unterminated substitutions with their opening positions", () => {
    expect(() => extractGitCommits('rg -n "x|`\\./admin.sh|y" file')).toThrow(
      "Unterminated backtick substitution starting at character 10. Close it, escape a literal backtick as \\`, or use single quotes."
    );
    expect(() => extractGitCommits("echo `git commit")).toThrow(
      "Unterminated backtick substitution starting at character 6."
    );
    expect(() => extractGitCommits("echo $(printf x")).toThrow(
      "Unterminated $( substitution starting at character 6. Close it with ) or use single quotes for literal text."
    );
    expect(() => extractGitCommits('echo "$(printf x')).toThrow(
      "Unterminated $( substitution starting at character 7."
    );

    expect(extractGitCommits('rg -n "x|\\`\\./admin.sh|y" file')).toEqual([]);
    expect(extractGitCommits("rg -n 'x|`\\./admin.sh|y' file")).toEqual([]);
    expect(() => extractGitCommits('echo $(echo "`unterminated)')).toThrow(
      "Unterminated backtick substitution starting at character 14"
    );
  });

  test("rejects unterminated quotes with the quote kind and opening position", () => {
    expect(() => extractGitCommits("echo 'x")).toThrow(
      "Unterminated single quote starting at character 6. Close the quote before running the command."
    );
    expect(() => extractGitCommits('echo "x')).toThrow(
      "Unterminated double quote starting at character 6. Close the quote before running the command."
    );
    expect(() => extractGitCommits("echo $'x")).toThrow(
      "Unterminated ANSI-C quote starting at character 6. Close the quote before running the command."
    );
    expect(() =>
      extractGitCommits("timeout 60 ssh host 'unterminated")
    ).toThrow("Unterminated single quote");
  });

  test("does not execute tab-stripped heredoc bodies as commands", () => {
    expect(
      extractGitCommits('cat <<-EOF\n\tgit commit -m "bad"\n\tEOF\n')
    ).toEqual([]);
    expect(
      extractGitCommits(
        "cat <<-'EOF'\n\tgit commit -m bad\n\tEOF\ngit commit -m 'core: actual' -s"
      )[0]?.messages
    ).toEqual(["core: actual"]);
  });

  test("rejects --trailer in both forms without including raw trailer text", () => {
    for (const trailer of [
      '--trailer "Signed-off-by: Private <private@example.com>"',
      '--trailer="Signed-off-by: Private <private@example.com>"',
    ]) {
      const command = `git commit -m 'core: Subject' ${trailer}`;

      try {
        validateGitCommits(extractGitCommits(command), defaultConfig, command);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);

        if (error instanceof Error) {
          expect(error.message).toContain("Cannot validate --trailer");
          expect(error.message).not.toContain("private@example.com");
        }
      }
    }
  });
  test.each<[string, Partial<GitCommitInvocation>]>([
    [
      "git commit -m 'kernel: fix race' -s",
      { messages: ["kernel: fix race"], hasSignoffFlag: true, isAmend: false },
    ],
    [
      'git commit -sm "kernel: fix deadlock"',
      { messages: ["kernel: fix deadlock"], hasSignoffFlag: true },
    ],
    [
      'git commit -sam "kernel: fix race"',
      { messages: ["kernel: fix race"], hasSignoffFlag: true },
    ],
    [
      'git commit -sm"kernel: fix adjacent" -a',
      { messages: ["kernel: fix adjacent"], hasSignoffFlag: true },
    ],
    [
      'git commit -m "kernel: add foo" -m "Body paragraph 1" -m "Signed-off-by: Dev <dev@example.com>"',
      {
        messages: [
          "kernel: add foo",
          "Body paragraph 1",
          "Signed-off-by: Dev <dev@example.com>",
        ],
        hasSignoffFlag: false,
      },
    ],
    [
      'git commit --signoff --message="releasetools: fix ota"',
      { messages: ["releasetools: fix ota"], hasSignoffFlag: true },
    ],
    [
      "git commit -F commit_msg.txt -s",
      { filePaths: ["commit_msg.txt"], hasSignoffFlag: true },
    ],
    [
      "git commit --file=/tmp/msg.txt --signoff",
      { filePaths: ["/tmp/msg.txt"] },
    ],
    [
      "git commit --amend --no-edit",
      { isAmend: true, hasNoEdit: true, messages: [] },
    ],
    [
      'git commit --amend -m "kernel: amended msg" -s',
      { isAmend: true, messages: ["kernel: amended msg"] },
    ],
    ["git commit --fixup HEAD~2", { isFixup: true }],
    ["git commit --fixup=abc123", { isFixup: true }],
    ["git commit --fixup=amend:def456", { isFixup: true }],
    [
      'git commit --squash HEAD~3 -m "squash! scope: msg" -s',
      { messages: ["squash! scope: msg"], hasSignoffFlag: true },
    ],
    [
      'git commit --squash=def456 -m "squash! scope: msg" -s',
      { messages: ["squash! scope: msg"], hasSignoffFlag: true },
    ],
    [
      'git commit --author="Dev <dev@example.com>" --cleanup=strip --fixup=HEAD -s',
      { isFixup: true, hasSignoffFlag: true },
    ],
    [
      'GIT_AUTHOR_NAME="Alice" git commit -m "build: fix" -s',
      { messages: ["build: fix"], hasSignoffFlag: true },
    ],
    ['env VAR=1 git commit -m "build: fix" -s', { messages: ["build: fix"] }],
    [
      'git -C /path/to/repo commit -m "fs: fix leak" -s',
      { messages: ["fs: fix leak"] },
    ],
    [
      'git --git-dir=/repo/.git --work-tree=/repo commit -m "fs: fix leak" -s',
      { messages: ["fs: fix leak"] },
    ],
    [
      "git --git-dir .git --work-tree . commit --amend --no-edit",
      { isAmend: true },
    ],
    [
      'git commit -m "ui: update layout" -s -- src/index.ts',
      { messages: ["ui: update layout"], hasSignoffFlag: true },
    ],
    ["git commit --help", { isHelp: true }],
    [
      'git commit -m "kernel: fix" # --help -s',
      { isHelp: false, hasSignoffFlag: false },
    ],
    [
      'echo "$(printf %s foo\\ #bar)"; git commit -m bad',
      { messages: ["bad"] },
    ],
  ])("extracts flags, wrappers, and subcommands: %s", (command, expected) => {
    expectSingleCommit(command, expected);
  });

  test.each([
    "git log --grep='commit'",
    "git status",
    "git commit-tree 123456",
    "git diff HEAD~1",
    'echo "git commit -m \\"test\\""',
    'grep -rn "git commit" .',
  ])("ignores non-commit commands: %s", (command) => {
    expect(extractGitCommits(command)).toEqual([]);
  });

  test("extracts multiple git commits from chained commands", () => {
    const invocations = extractGitCommits(
      'git commit -m "scope1: first" -s && cd ../other && git commit -m "scope2: second" -s'
    );

    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.messages).toEqual(["scope1: first"]);
    expect(invocations[1]?.messages).toEqual(["scope2: second"]);

    for (const mutation of [
      "export GIT_DIR=/other/.git",
      "typeset -x GIT_DIR=/other/.git",
      "declare -x GIT_DIR=/other/.git",
      "source ./git-env.sh",
      ". ./git-env.sh",
      "eval 'export GIT_DIR=/other/.git'",
      "set -a; GIT_DIR=/other/.git; GIT_WORK_TREE=/other",
      "unset GIT_DIR",
      "readonly GIT_DIR=/other/.git",
    ]) {
      const changed = extractGitCommits(
        `${mutation}; git commit -m 'core: Update'`
      );

      expect(changed).toHaveLength(1);
      expect(changed[0]?.targetError).toContain(
        "preceding directory or environment change"
      );
    }
  });
});

const pwsh = (command: string) => extractGitCommits(command, { shell: "pwsh" });

const encodePwsh = (script: string) =>
  Buffer.from(script, "utf16le").toString("base64");

describe("PowerShell 7 (pwsh) parsing", () => {
  test("parses single quotes with doubled escapes and smart quotes", () => {
    expect(pwsh("git commit -s -m 'core: Don''t break'")[0]?.messages).toEqual([
      "core: Don't break",
    ]);
    expect(
      pwsh("git commit -s -m ‘core: Smart’’s quote’")[0]?.messages
    ).toEqual(["core: Smart’s quote"]);
    expect(pwsh('git commit -s -m “core: Say ""hi""”')[0]?.messages).toEqual([
      'core: Say "hi"',
    ]);
  });

  test("parses backtick escapes, Unicode escapes, and line continuations", () => {
    expect(
      pwsh('git commit -s -m "core: Line one`n`nLine two `"quoted`""')[0]
        ?.messages
    ).toEqual(['core: Line one\n\nLine two "quoted"']);
    expect(pwsh('git commit -s -m "core: Caf`u{00E9}"')[0]?.messages).toEqual([
      "core: Caf\u00E9",
    ]);
    expect(
      pwsh("git commit `\n  -s `\n  -m 'core: Continued'")[0]?.messages
    ).toEqual(["core: Continued"]);
  });

  test("strips line comments and inline or multiline block comments", () => {
    expect(
      pwsh(
        "<# leading comment #> git commit <# inline #> -s -m 'core: Clean' # trailing\n"
      )[0]?.messages
    ).toEqual(["core: Clean"]);
    expect(pwsh("# git commit -m 'ignored'\ngit status")).toEqual([]);
    expect(pwsh("<#\ngit commit -m 'ignored'\n#>\ngit status")).toEqual([]);
  });

  test("accepts literal here-strings via -m and single-stage stdin pipelines", () => {
    const inline = pwsh(
      "git commit -s -m @'\ncore: Inline here-string\n\nBody with $var literal.\n'@"
    );

    expect(inline).toHaveLength(1);
    expect(inline[0]?.messages).toEqual([
      "core: Inline here-string\n\nBody with $var literal.",
    ]);
    expect(inline[0]?.messageExpansion).toBe(false);

    const piped = pwsh(
      "@'\ncore: Piped here-string\n\nBody line.\n'@ | git commit -s -F -"
    );

    expect(piped).toHaveLength(1);
    expect(piped[0]?.stdinMessage).toBe(
      "core: Piped here-string\n\nBody line."
    );
    expect(piped[0]?.stdinError).toBeUndefined();
    expect(() => {
      validateGitCommits(piped, defaultConfig);
    }).not.toThrow();
  });

  test("rejects expandable here-string pipelines, multi-stage pipelines, and disk -F", () => {
    const expandablePiped = pwsh(
      '@"\ncore: Expandable $var\n"@ | git commit -s -F -'
    );

    expect(expandablePiped[0]?.stdinError).toContain("here-string");

    const multiStage = pwsh(
      "@'\ncore: Multi\n'@ | Out-String | git commit -s -F -"
    );

    expect(multiStage[0]?.stdinError).toContain("here-string");

    const expandableInline = pwsh('git commit -s -m @"\ncore: Hello $user\n"@');

    expect(expandableInline[0]?.messageExpansion).toBe(true);
    expect(
      pwsh('Write-Output @"\n$(git commit -m bad)\n"@')[0]?.messages
    ).toEqual(["bad"]);
  });

  test("handles call operator, subexpressions, and Windows git.exe paths", () => {
    expect(
      pwsh("& git commit -s -m 'core: Call operator'")[0]?.messages
    ).toEqual(["core: Call operator"]);
    expect(
      pwsh(
        "& 'C:\\Program Files\\Git\\cmd\\git.exe' commit -s -m 'core: Path'"
      )[0]?.messages
    ).toEqual(["core: Path"]);
    expect(pwsh("Write-Output $(git commit -m 'bad')")[0]?.messages).toEqual([
      "bad",
    ]);
    expect(pwsh("Write-Output @(git commit -m 'bad')")[0]?.messages).toEqual([
      "bad",
    ]);
    expect(pwsh("git commit --% -s -m core:Stop")[0]?.messages).toEqual([
      "core:Stop",
    ]);
    expect(
      pwsh("git --%\u00A0commit -s -m core:LeadNbsp")[0]?.messages
    ).toEqual(["core:LeadNbsp"]);
  });

  test("unwraps nested pwsh -Command, -CommandWithArgs, and -EncodedCommand across modes", () => {
    expect(
      extractGitCommits(
        `pwsh -NoProfile -c "git commit -s -m 'core: Nested'"`
      )[0]?.messages
    ).toEqual(["core: Nested"]);
    expect(
      pwsh(
        `pwsh.exe /NonInteractive –Command git commit -s -m "'core: Joined'"`
      )[0]?.messages
    ).toEqual(["core: Joined"]);
    expect(
      pwsh(`pwsh -cwa "git commit -s -m 'core: Cwa'" extra`)[0]?.messages
    ).toEqual(["core: Cwa"]);

    const encoded = encodePwsh("git commit -s -m 'core: Encoded'");

    expect(
      extractGitCommits(`pwsh -NoLogo -ec ${encoded}`)[0]?.messages
    ).toEqual(["core: Encoded"]);
    expect(
      pwsh(`pwsh -wd ../other -EncodedCommand ${encoded}`)[0]?.targetError
    ).toContain("preceding directory or environment change");
    expect(pwsh(`pwsh -enc ${encoded} -wd ../other`)[0]?.targetError).toContain(
      "preceding directory or environment change"
    );
    expect(
      pwsh(`pwsh -com "git commit -s -m 'core: Abbrev'"`)[0]?.messages
    ).toEqual(["core: Abbrev"]);
    expect(
      pwsh(`pwsh -o XML -c "git commit -s -m 'core: Out'"`)[0]?.messages
    ).toEqual(["core: Out"]);
    expect(
      pwsh(`pwsh -i -c "git commit -s -m 'core: Interactive'"`)[0]?.messages
    ).toEqual(["core: Interactive"]);
    expect(
      pwsh(`pwsh -config test -c "git commit -s -m 'core: Config'"`)[0]
        ?.messages
    ).toEqual(["core: Config"]);
  });

  test("handles stream merges, stop-parsing pipelines, parenthesized args, subexpression mutators, and Unicode CharTraits", () => {
    expect(pwsh("(Get-Date)")).toEqual([]);
    expect(
      pwsh("git 2>&1 commit -s -m 'core: After merge'")[0]?.messages
    ).toEqual(["core: After merge"]);
    expect(
      pwsh("git status --% foo | git commit -s -m 'core: After stop'")[0]
        ?.messages
    ).toEqual(["core: After stop"]);
    expect(
      pwsh("git status --% foo && git commit -s -m 'core: After chain'")[0]
        ?.messages
    ).toEqual(["core: After chain"]);

    const parenTarget = pwsh(
      "git -C ('../other') commit -s -m 'core: Paren arg'"
    );

    expect(parenTarget).toHaveLength(1);
    expect(parenTarget[0]?.messages).toEqual(["core: Paren arg"]);
    expect(parenTarget[0]?.targetError).toContain(
      "Git global directory or configuration flags"
    );
    expect(() => pwsh("git ('commit') -m 'core: Dynamic subcommand'")).toThrow(
      "Pre-execution shell inspection failed"
    );
    expect(
      pwsh(
        "Write-Output $(Set-Location ../other); git commit -s -m 'core: Sub'"
      )[0]?.targetError
    ).toContain("preceding directory or environment change");
    expect(pwsh("git\u00A0commit -s -m 'core: Nbsp'")[0]?.messages).toEqual([
      "core: Nbsp",
    ]);
    expect(pwsh("git\u0085commit -s -m 'core: Nel'")[0]?.messages).toEqual([
      "core: Nel",
    ]);
    expect(pwsh("git\u2028commit -s -m 'core: Lsep'")[0]?.messages).toEqual([
      "core: Lsep",
    ]);
    expect(pwsh("git\u2029commit -s -m 'core: Psep'")[0]?.messages).toEqual([
      "core: Psep",
    ]);
    expect(
      pwsh("# comment\rgit commit -s -m 'core: After CR'")[0]?.messages
    ).toEqual(["core: After CR"]);
    expect(
      pwsh('git commit -s -m "core: $caf\u00E9"')[0]?.messageExpansion
    ).toBe(true);
    expect(() => pwsh("git commit @caf\u00E9")).toThrow(
      "Pre-execution shell inspection failed"
    );
  });

  test("marks pwsh target mutators as ambiguous", () => {
    for (const mutation of [
      "cd ../other",
      "sl ../other",
      "Set-Location ../other",
      "Push-Location ../other",
      "pushd ../other",
      "Pop-Location",
      "popd",
      "$env:GIT_DIR = '/other/.git'",
      "Set-Variable GIT_DIR '/other/.git'",
      "sv GIT_DIR '/other/.git'",
      "iex 'cd ../other'",
      "Invoke-Expression 'cd ../other'",
      ". ./env.ps1",
    ]) {
      const changed = pwsh(`${mutation}; git commit -s -m 'core: Mutated'`);

      expect(changed).toHaveLength(1);
      expect(changed[0]?.targetError).toContain(
        "preceding directory or environment change"
      );
    }
  });

  test.each([
    ["splatting", "git commit @args"],
    ["dynamic call operator", "& $cmd commit -m 'core: Dynamic'"],
    ["stop-parsing env var", "git commit --% -m %MSG%"],
    ["stop-parsing quoted args", 'git commit --% -s -m "core: Stop parsing"'],
    ["stop-parsing smart quotes", "git commit --% -m \u201Ccore: Smart\u201D"],
    ["stop-parsing embedded tab", "git commit --% -m\tcore:Tab"],
    ["unmatched closing parenthesis", "git status )"],
    ["pwsh -NoExit", "pwsh -NoExit -c 'git status'"],
    ["pwsh -isswait", "pwsh -isswait -c 'git status'"],
    ["pwsh -File", "pwsh -File ./commit.ps1"],
    ["pwsh -c -", "pwsh -c -"],
    ["pwsh -cwa -", "pwsh -cwa -"],
    ["bare pwsh", "pwsh -NoProfile"],
    ["pwsh -ea", "pwsh -ea AAAA -c 'git status'"],
    ["positional pwsh script", "pwsh ./commit.ps1"],
    ["invalid base64", "pwsh -EncodedCommand not-valid-base64!"],
    ["odd UTF-16LE base64", "pwsh -EncodedCommand QQ=="],
    ["unterminated block comment", "git status <# unclosed"],
    ["unterminated here-string", "git commit -m @'\nunterminated"],
  ])("fails closed on %s", (_label, command) => {
    expect(() => pwsh(command)).toThrow(
      "Pre-execution shell inspection failed"
    );
  });
});
