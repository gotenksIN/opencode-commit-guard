import { describe, expect, test } from "bun:test";

import { extractGitCommits } from "../src/shell.js";
import { defaultConfig } from "../src/types.js";
import { validateGitCommits } from "../src/validator.js";

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
  test("tokenizes simple commands with whitespace", () => {
    expect(extractGitCommits("git commit -m 'first commit' -s")).toMatchObject([
      { messages: ["first commit"], hasSignoffFlag: true },
    ]);
  });

  test("handles single and double quotes with spaces", () => {
    expect(
      extractGitCommits('git commit -m "kernel: add support for foo" --signoff')
    ).toMatchObject([
      { messages: ["kernel: add support for foo"], hasSignoffFlag: true },
    ]);
  });

  test("handles escaped quotes inside double quotes", () => {
    expect(
      extractGitCommits(
        'git commit -m "parser: support \\"quoted\\" values" -s'
      )
    ).toMatchObject([
      { messages: ['parser: support "quoted" values'], hasSignoffFlag: true },
    ]);
  });

  test("handles line continuations with backslash newline", () => {
    expect(
      extractGitCommits("git commit \\\n  -m 'kernel: fix' \\\n  -s")
    ).toMatchObject([{ messages: ["kernel: fix"], hasSignoffFlag: true }]);
  });

  test("discards line continuations inside double quotes", () => {
    expect(
      extractGitCommits('git commit -m "kernel: fix \\\nrace" -s')
    ).toMatchObject([{ messages: ["kernel: fix race"], hasSignoffFlag: true }]);
  });

  test("handles chained operators and subshells", () => {
    expect(
      extractGitCommits(
        "(cd repo && git commit -m 'docs: update' -s) || echo failed"
      )
    ).toMatchObject([
      {
        messages: ["docs: update"],
        hasSignoffFlag: true,
      },
    ]);
  });

  test("preserves control operators inside quotes without splitting", () => {
    expect(
      extractGitCommits(
        'git commit -m "scope: handle foo && bar; test || check" -s'
      )
    ).toMatchObject([
      {
        messages: ["scope: handle foo && bar; test || check"],
        hasSignoffFlag: true,
      },
    ]);
  });

  test("handles redirects and file descriptors", () => {
    expect(
      extractGitCommits("git commit -m 'scope: fix' -s > /dev/null 2>&1")
    ).toMatchObject([{ messages: ["scope: fix"], hasSignoffFlag: true }]);
  });

  test("concatenates adjacent unquoted and quoted tokens", () => {
    expect(
      extractGitCommits('git commit --message="kernel: add foo" -s')
    ).toMatchObject([{ messages: ["kernel: add foo"], hasSignoffFlag: true }]);
  });
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
  test("extracts standard git commit with -m and -s flags", () => {
    const invocations = extractGitCommits(
      "git commit -m 'kernel: fix race' -s"
    );

    expect(invocations).toHaveLength(1);
    const [first] = invocations;
    expect(first?.messages).toEqual(["kernel: fix race"]);
    expect(first?.hasSignoffFlag).toBe(true);
    expect(first?.isAmend).toBe(false);
  });

  test("extracts combined short flags like -sm and -sam", () => {
    const invocations = extractGitCommits(
      'git commit -sm "kernel: fix deadlock"'
    );

    expect(invocations).toHaveLength(1);
    const [first] = invocations;
    expect(first?.messages).toEqual(["kernel: fix deadlock"]);
    expect(first?.hasSignoffFlag).toBe(true);

    const sam = extractGitCommits('git commit -sam "kernel: fix race"');
    expect(sam).toHaveLength(1);
    expect(sam[0]?.messages).toEqual(["kernel: fix race"]);
    expect(sam[0]?.hasSignoffFlag).toBe(true);
  });

  test("extracts combined short flag with adjacent message string", () => {
    const invocations = extractGitCommits(
      'git commit -sm"kernel: fix adjacent" -a'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["kernel: fix adjacent"]);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);
  });

  test("extracts multiple -m flags in order", () => {
    const invocations = extractGitCommits(
      'git commit -m "kernel: add foo" -m "Body paragraph 1" -m "Signed-off-by: Dev <dev@example.com>"'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual([
      "kernel: add foo",
      "Body paragraph 1",
      "Signed-off-by: Dev <dev@example.com>",
    ]);
    expect(invocations[0]?.hasSignoffFlag).toBe(false);
  });

  test("extracts long options --message and --signoff", () => {
    const invocations = extractGitCommits(
      'git commit --signoff --message="releasetools: fix ota"'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["releasetools: fix ota"]);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);
  });

  test("extracts -F and --file options", () => {
    const invocations = extractGitCommits("git commit -F commit_msg.txt -s");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.filePaths).toEqual(["commit_msg.txt"]);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);

    const longOpt = extractGitCommits(
      "git commit --file=/tmp/msg.txt --signoff"
    );

    expect(longOpt).toHaveLength(1);
    expect(longOpt[0]?.filePaths).toEqual(["/tmp/msg.txt"]);
  });

  test("extracts amend commits", () => {
    const amendNoEdit = extractGitCommits("git commit --amend --no-edit");
    expect(amendNoEdit).toHaveLength(1);
    expect(amendNoEdit[0]?.isAmend).toBe(true);
    expect(amendNoEdit[0]?.hasNoEdit).toBe(true);
    expect(amendNoEdit[0]?.messages).toHaveLength(0);

    const amendWithMessage = extractGitCommits(
      'git commit --amend -m "kernel: amended msg" -s'
    );

    expect(amendWithMessage).toHaveLength(1);
    expect(amendWithMessage[0]?.isAmend).toBe(true);
    expect(amendWithMessage[0]?.messages).toEqual(["kernel: amended msg"]);
  });

  test("identifies fixup flag from separate and joined long options", () => {
    const separate = extractGitCommits("git commit --fixup HEAD~2");
    expect(separate[0]?.isFixup).toBe(true);

    const joined = extractGitCommits("git commit --fixup=abc123");
    expect(joined[0]?.isFixup).toBe(true);

    const amend = extractGitCommits("git commit --fixup=amend:def456");
    expect(amend[0]?.isFixup).toBe(true);
  });

  test("parses options following separate and joined squash flag", () => {
    const separate = extractGitCommits(
      'git commit --squash HEAD~3 -m "squash! scope: msg" -s'
    );

    expect(separate[0]?.messages).toEqual(["squash! scope: msg"]);
    expect(separate[0]?.hasSignoffFlag).toBe(true);

    const joined = extractGitCommits(
      'git commit --squash=def456 -m "squash! scope: msg" -s'
    );

    expect(joined[0]?.messages).toEqual(["squash! scope: msg"]);
    expect(joined[0]?.hasSignoffFlag).toBe(true);
  });

  test("continues parsing flags after long options with joined arguments", () => {
    const invocations = extractGitCommits(
      'git commit --author="Dev <dev@example.com>" --cleanup=strip --fixup=HEAD -s'
    );

    expect(invocations[0]?.isFixup).toBe(true);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);
  });

  test("identifies git commit after leading environment variables", () => {
    const invocations = extractGitCommits(
      'GIT_AUTHOR_NAME="Alice" git commit -m "build: fix" -s'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["build: fix"]);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);
  });

  test("identifies git commit after command wrappers", () => {
    const invocations = extractGitCommits(
      'env VAR=1 git commit -m "build: fix" -s'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["build: fix"]);
  });

  test("handles global git flags preceding commit subcommand", () => {
    const invocations = extractGitCommits(
      'git -C /path/to/repo commit -m "fs: fix leak" -s'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["fs: fix leak"]);

    const dirFlag = extractGitCommits(
      'git --git-dir=/repo/.git --work-tree=/repo commit -m "fs: fix leak" -s'
    );

    expect(dirFlag).toHaveLength(1);
    expect(dirFlag[0]?.messages).toEqual(["fs: fix leak"]);

    const separate = extractGitCommits(
      "git --git-dir .git --work-tree . commit --amend --no-edit"
    );

    expect(separate).toHaveLength(1);
    expect(separate[0]?.isAmend).toBe(true);
  });

  test("ignores non-commit git subcommands", () => {
    expect(extractGitCommits("git log --grep='commit'")).toHaveLength(0);
    expect(extractGitCommits("git status")).toHaveLength(0);
    expect(extractGitCommits("git commit-tree 123456")).toHaveLength(0);
    expect(extractGitCommits("git diff HEAD~1")).toHaveLength(0);
  });

  test("ignores commands that mention git commit as argument or string", () => {
    expect(extractGitCommits('echo "git commit -m \\"test\\""')).toHaveLength(
      0
    );
    expect(extractGitCommits('grep -rn "git commit" .')).toHaveLength(0);
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

  test("handles positional arguments separator --", () => {
    const invocations = extractGitCommits(
      'git commit -m "ui: update layout" -s -- src/index.ts'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["ui: update layout"]);
    expect(invocations[0]?.hasSignoffFlag).toBe(true);
  });

  test("handles --help flag", () => {
    const invocations = extractGitCommits("git commit --help");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.isHelp).toBe(true);
  });

  test("does not parse flags inside shell comments", () => {
    const invocations = extractGitCommits(
      'git commit -m "kernel: fix" # --help -s'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.isHelp).toBe(false);
    expect(invocations[0]?.hasSignoffFlag).toBe(false);
  });

  test("keeps escaped spaces inside substitution words", () => {
    const invocations = extractGitCommits(
      'echo "$(printf %s foo\\ #bar)"; git commit -m bad'
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.messages).toEqual(["bad"]);
  });
});
