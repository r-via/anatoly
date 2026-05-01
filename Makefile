# anatoly — dev install Makefile
#
# Use this from a fresh `git clone` to install anatoly globally
# from source — for testing unpublished commits or feature branches.
#
# This sidesteps two known bugs in `npm install -g github:r-via/anatoly`:
#   1. NPM_CONFIG_GLOBAL inheritance — pacote's inner `npm install --include=dev`
#      runs with global=true inherited from the outer global install, which
#      makes it skip placing devDependencies (tsup, typescript, …) and
#      `prepare` then dies with `tsup: not found`.
#   2. ext4 race in tar extraction — even when the inner install works,
#      the outer global extract races on chmod for transitive bin links
#      (acorn, glob, …) on WSL ext4.
#
# The manual `npm install` + `npm install -g .` flow this Makefile drives
# avoids both: it never runs as global until the local install is fully
# committed to disk.

SHELL       := /bin/bash
NPM         := npm
PKG_NAME    := $(shell node -p "require('./package.json').name" 2>/dev/null)
PKG_VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)

# ---- ANSI -----------------------------------------------------------------
B := \033[1m
D := \033[2m
R := \033[31m
G := \033[32m
Y := \033[33m
C := \033[36m
M := \033[35m
N := \033[0m

.DEFAULT_GOAL := help
.PHONY: help install install-deps install-global uninstall build rebuild test lint typecheck clean doctor

help:
	@printf '$(B)$(M)anatoly$(N) $(D)— dev Makefile$(N)\n\n'
	@printf '$(D)Run from a fresh `git clone https://github.com/r-via/anatoly`:$(N)\n\n'
	@printf '  $(C)make install$(N)        $(D)complete dev install (deps + build + global symlink)$(N)\n'
	@printf '  $(C)make build$(N)          $(D)build dist/ via tsup$(N)\n'
	@printf '  $(C)make rebuild$(N)        $(D)clean + build$(N)\n'
	@printf '  $(C)make install-global$(N) $(D)link this clone as the global anatoly bin$(N)\n'
	@printf '  $(C)make uninstall$(N)      $(D)remove the global anatoly bin$(N)\n'
	@printf '  $(C)make test$(N)           $(D)run vitest$(N)\n'
	@printf '  $(C)make lint$(N)           $(D)run eslint$(N)\n'
	@printf '  $(C)make typecheck$(N)      $(D)run tsc --noEmit$(N)\n'
	@printf '  $(C)make doctor$(N)         $(D)report node/npm/anatoly versions$(N)\n'
	@printf '  $(C)make clean$(N)          $(D)rm -rf dist node_modules$(N)\n\n'
	@printf '$(D)Why not `npm install -g github:r-via/anatoly`?$(N)\n'
	@printf '$(D)  See the comment block at the top of this Makefile.$(N)\n'

install: install-deps install-global
	@printf '\n$(G)✔ anatoly installed globally from source$(N)\n'
	@printf '  $(D)version$(N)  $(PKG_VERSION)\n'
	@bin=$$(command -v anatoly 2>/dev/null); \
	 if [ -n "$$bin" ]; then printf '  $(D)bin$(N)      %s\n' "$$bin"; \
	 else printf '  $(D)bin$(N)      $(R)not in PATH$(N)\n'; fi
	@printf '  $(D)try$(N)      $(B)anatoly --version$(N)\n\n'

install-deps:
	@printf '$(B)[1/2]$(N) $(C)installing local dependencies (this also runs `prepare` → tsup → dist/)$(N)\n'
	@$(NPM) install --no-audit --no-fund --no-progress
	@printf '$(G)  ✔$(N) deps + dist/ ready\n\n'

install-global:
	@printf '$(B)[2/2]$(N) $(C)installing global bin from this clone$(N)\n'
	@$(NPM) install -g . --no-audit --no-fund --no-progress
	@printf '$(G)  ✔$(N) global bin linked\n'

build:
	@printf '$(B)→$(N) $(C)building dist/$(N)\n'
	@$(NPM) run build

rebuild: clean build

uninstall:
	@printf '$(Y)→$(N) removing global $(B)$(PKG_NAME)$(N)\n'
	@$(NPM) uninstall -g $(PKG_NAME) 2>&1 | tail -3 || true
	@printf '$(G)  ✔$(N) uninstalled\n'

test:
	@$(NPM) run test

lint:
	@$(NPM) run lint

typecheck:
	@$(NPM) run typecheck

clean:
	@printf '$(Y)→$(N) cleaning $(B)dist/$(N) and $(B)node_modules/$(N)\n'
	@rm -rf dist node_modules
	@printf '$(G)  ✔$(N) clean\n'

doctor:
	@printf '$(B)$(M)anatoly$(N) $(D)— environment$(N)\n\n'
	@node_p=$$(command -v node 2>/dev/null); node_v=$$(node --version 2>/dev/null); \
	 npm_p=$$(command -v npm 2>/dev/null); npm_v=$$(npm --version 2>/dev/null); \
	 anatoly_p=$$(command -v anatoly 2>/dev/null); anatoly_v=$$(anatoly --version 2>/dev/null); \
	 printf '  $(D)node$(N)     %s $(D)%s$(N)\n' "$$node_p" "$$node_v"; \
	 printf '  $(D)npm$(N)      %s $(D)%s$(N)\n' "$$npm_p" "$$npm_v"; \
	 if [ -x ./node_modules/.bin/tsup ]; then printf '  $(D)tsup$(N)     ./node_modules/.bin/tsup $(G)✔$(N)\n'; \
	 else printf '  $(D)tsup$(N)     $(R)missing — run make install$(N)\n'; fi; \
	 if [ -f ./dist/index.js ]; then sz=$$(stat -c "%s" ./dist/index.js); printf '  $(D)dist/$(N)    %s bytes $(G)✔$(N)\n' "$$sz"; \
	 else printf '  $(D)dist/$(N)    $(R)not built$(N)\n'; fi; \
	 if [ -n "$$anatoly_p" ]; then printf '  $(D)anatoly$(N)  %s $(D)%s$(N)\n' "$$anatoly_p" "$$anatoly_v"; \
	 else printf '  $(D)anatoly$(N)  $(R)not in PATH$(N)\n'; fi
