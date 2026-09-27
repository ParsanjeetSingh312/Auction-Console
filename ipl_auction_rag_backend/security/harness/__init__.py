"""
The security suite's shared harness.

Nothing in here is a test. It is the scaffolding every phase leans on: a
throwaway AUCTIQ seeded with fake players (`staging`) and the attack corpora the
red-team phases fire (`payloads`). Keeping it apart from the test files means a
payload list or a seeding change is edited in one place rather than copied into
four.
"""
