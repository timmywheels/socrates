# Socrates

A code reviewer for [Claude Code](https://claude.com/claude-code) that only asks questions.

## Table of Contents

- [What It Does](#what-it-does)
- [Install](#install)
- [Usage](#usage)
- [The Socrates Pane](#the-socrates-pane)
- [Development](#development)

---

## What It Does

Socrates reviews a pull request, a branch, or a commit range and asks at most five one-line questions, each anchored to a line of the diff. It never tells you what to change. Every question is aimed at an assumption worth checking: an unhandled case, a broken invariant, a hidden coupling, a contract the change silently alters.

The plugin ships two pieces that work together:

- **The `socrates` skill**, which runs the review.
- **The Socrates pane**, a panel beside the chat where you work through the questions.

---

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install socrates --marketplace timmywheels/socrates
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it for every session).

From a shell:

```bash
claude plugin install socrates --marketplace timmywheels/socrates
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `timmywheels/socrates`, then **Add plugin**.

---

## Usage

Ask for a review in plain words:

```text
socrates this branch
socrates PR 123
post the Socrates review
address the open Socrates questions
```

Questions are printed in chat, or only summarised there when the pane is on screen. Posting submits a single `COMMENT` review to GitHub with each question inline; Socrates never approves, requests changes, or edits the PR.

---

## The Socrates Pane

The pane opens beside the chat when a review lands (terminal at least 110 columns wide, fullscreen rendering). Reopen it with `/socrates-board`.

| Key       | Does                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| `1`–`5`   | Show or hide the diff hunk under that question                                 |
| `a`       | Ask Claude to address every open question                                      |
| `r`       | Re-review only the commits since the reviewed SHA (shown when the review is stale) |
| `p`       | Post the review to the PR                                                      |
| `e`       | Show earlier rounds                                                            |
| `c`       | Clear the review                                                               |

Each open question also has **Address**, **I'll answer** and **Skip**. With **I'll answer** you reply in your own words and Socrates judges the answer, asking a follow-up when it leaves a gap.

The pane also:

- marks a question `touched` when Claude edits its file,
- warns when you commit past the reviewed SHA,
- saves reviews per branch, so they survive restarts and stack up as rounds,
- shows `🏛️ N open` in the status line,
- finds the right checkout when the branch lives in a git worktree.

The pane is a Claude Code mod, built on an early-access API that may change between Claude Code releases. The skill works on its own without it.

---

## Development

Load the plugin from a checkout:

```bash
claude --plugin-dir /path/to/socrates
```

Check and test it:

```bash
claude plugin validate .
claude plugin test .
```
