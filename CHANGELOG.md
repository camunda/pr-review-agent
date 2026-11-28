# Changelog

## [1.0.3](https://github.com/camunda/pr-review-agent/compare/v1.0.2...v1.0.3) (2026-11-28)


### Dependencies

* update anthropics/claude-code-action action to v1.0.289 ([#33](https://github.com/camunda/pr-review-agent/issues/33)) ([75a31fb](https://github.com/camunda/pr-review-agent/commit/75a31fbc1dcc65558ac4376a354e9b3954bfddc4))
* update anthropics/claude-code-action action to v1.0.290 ([#35](https://github.com/camunda/pr-review-agent/issues/35)) ([5f18f24](https://github.com/camunda/pr-review-agent/commit/5f18f24d68f10db918e957125c0720f4b655dfa6))

## [1.0.2](https://github.com/camunda/pr-review-agent/compare/v1.0.1...v1.0.2) (2026-11-27)


### Bug Fixes

* stop the reviewer from posting praise as a 💭 musing ([#30](https://github.com/camunda/pr-review-agent/issues/30)) ([ea2eb09](https://github.com/camunda/pr-review-agent/commit/ea2eb0961e57479b9122dfb0a5ccc4783f1e5e49))

## [1.0.1](https://github.com/camunda/pr-review-agent/compare/v1.0.0...v1.0.1) (2026-11-26)


### Bug Fixes

* count the review cap per config, using config= in the review marker ([#24](https://github.com/camunda/pr-review-agent/issues/24)) ([5ffeace](https://github.com/camunda/pr-review-agent/commit/5ffeace76e948d12e3dc65a04ee9b454597a0a25))
* fall back to the default branch when the rubric is missing at the PR base ([#25](https://github.com/camunda/pr-review-agent/issues/25)) ([fc7439b](https://github.com/camunda/pr-review-agent/commit/fc7439bbe0f8b794c671763f704827f6e7d9f4ec))
* name the config in the review-cap notice ([#27](https://github.com/camunda/pr-review-agent/issues/27)) ([d33de78](https://github.com/camunda/pr-review-agent/commit/d33de78b0109ff1090173f9f0c36592876fe6b06))
* pin the review agent's session to the default permission mode ([#18](https://github.com/camunda/pr-review-agent/issues/18)) ([3f0aaa5](https://github.com/camunda/pr-review-agent/commit/3f0aaa55e999ebadf749b542a741c9295f834ea4))


### Dependencies

* update anthropics/claude-code-action action to v1.0.284 ([#21](https://github.com/camunda/pr-review-agent/issues/21)) ([295483e](https://github.com/camunda/pr-review-agent/commit/295483e243b46b535c20ef278fc01d4ccd427e07))
* update step-security/harden-runner action to v2.23.0 ([#22](https://github.com/camunda/pr-review-agent/issues/22)) ([23aa01b](https://github.com/camunda/pr-review-agent/commit/23aa01bcfecba0758e8f472b5e1f448e74a361c6))

## 1.0.0 (2026-11-18)


### Features

* add opt-in cap on automatic reviews per PR ([28ddf69](https://github.com/camunda/pr-review-agent/commit/28ddf6918c6742e26986990fb5eddbb963fb66d9))
* add opt-in cap on automatic reviews per PR ([7d23a3c](https://github.com/camunda/pr-review-agent/commit/7d23a3c985fbe69d8f15052f8bcdbe1633e554e4))
* harden the review job for public repositories ([#7](https://github.com/camunda/pr-review-agent/issues/7)) ([649c5af](https://github.com/camunda/pr-review-agent/commit/649c5afeaf4da3f81a9aa7c9fb13b4ad878a8d47))


### Bug Fixes

* **examples:** keep unrelated label events from cancelling reviews ([6f03e49](https://github.com/camunda/pr-review-agent/commit/6f03e49828b1b6bd1c64f91378c78f8685ed3bd3))
* make the review-cap notice job best effort and one per PR ([b348a44](https://github.com/camunda/pr-review-agent/commit/b348a44d9a8c100e10612719c5ca7e334a451c35))
