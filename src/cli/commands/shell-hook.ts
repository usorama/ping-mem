/**
 * Shell hook generator command.
 *
 * Outputs shell integration code for zsh, bash, or fish.
 * Usage: ping-mem shell-hook zsh
 */

import { defineCommand } from "citty";

const ZSH_HOOK = `# ping-mem shell integration (zsh)
# Add to ~/.zshrc: eval "$(ping-mem shell-hook zsh)"

_ping_mem_sock="\${XDG_RUNTIME_DIR:-/tmp}/ping-mem-$(id -u).sock"

_ping_mem_send() {
  [[ -S "$_ping_mem_sock" ]] || return 0
  if command -v nc &>/dev/null; then
    printf '%s\\n' "$1" | nc -U "$_ping_mem_sock" 2>/dev/null &!
  elif command -v socat &>/dev/null; then
    printf '%s\\n' "$1" | socat - UNIX-CONNECT:"$_ping_mem_sock" 2>/dev/null &!
  fi
}

_ping_mem_precmd() { _ping_mem_send "precmd:$PWD"; }
_ping_mem_chpwd() { _ping_mem_send "chdir:$PWD"; }

autoload -Uz add-zsh-hook
add-zsh-hook precmd _ping_mem_precmd
add-zsh-hook chpwd _ping_mem_chpwd
`;

const BASH_HOOK = `# ping-mem shell integration (bash)
# Add to ~/.bashrc: eval "$(ping-mem shell-hook bash)"

_ping_mem_sock="\${XDG_RUNTIME_DIR:-/tmp}/ping-mem-$(id -u).sock"

_ping_mem_send() {
  [[ -S "$_ping_mem_sock" ]] || return 0
  if command -v nc &>/dev/null; then
    printf '%s\\n' "$1" | nc -U "$_ping_mem_sock" 2>/dev/null &
  elif command -v socat &>/dev/null; then
    printf '%s\\n' "$1" | socat - UNIX-CONNECT:"$_ping_mem_sock" 2>/dev/null &
  fi
}

PROMPT_COMMAND="_ping_mem_send \\"precmd:\\$PWD\\";\${PROMPT_COMMAND:+\$PROMPT_COMMAND}"

_ping_mem_original_cd() { builtin cd "\$@" && _ping_mem_send "chdir:\$PWD"; }
alias cd='_ping_mem_original_cd'
`;

const FISH_HOOK = `# ping-mem shell integration (fish)
# Add to ~/.config/fish/config.fish: ping-mem shell-hook fish | source

set -g _ping_mem_sock (test -n "$XDG_RUNTIME_DIR"; and echo "$XDG_RUNTIME_DIR"; or echo "/tmp")"/ping-mem-"(id -u)".sock"

function _ping_mem_send
  test -S "$_ping_mem_sock"; or return 0
  if command -sq nc
    printf '%s\\n' $argv[1] | nc -U "$_ping_mem_sock" 2>/dev/null &
  else if command -sq socat
    printf '%s\\n' $argv[1] | socat - UNIX-CONNECT:"$_ping_mem_sock" 2>/dev/null &
  end
end

function _ping_mem_prompt --on-event fish_prompt
  _ping_mem_send "precmd:$PWD"
end

function _ping_mem_chdir --on-variable PWD
  _ping_mem_send "chdir:$PWD"
end
`;

const SHELL_HOOKS: Record<string, string> = {
  zsh: ZSH_HOOK,
  bash: BASH_HOOK,
  fish: FISH_HOOK,
};

export default defineCommand({
  meta: { name: "shell-hook", description: "Generate shell integration code" },
  args: {
    shell: {
      type: "positional",
      description: "Shell type: zsh, bash, or fish",
      required: true,
    },
  },
  run({ args }) {
    const shell = args.shell.toLowerCase();
    const hook = SHELL_HOOKS[shell];
    if (!hook) {
      console.error(`Unsupported shell: ${shell}. Supported: zsh, bash, fish`);
      process.exit(1);
    }
    // Output raw hook code — meant to be eval'd by the shell
    process.stdout.write(hook);
  },
});
