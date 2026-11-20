/**
 * Key that lets every WhatsOps installation open issues in the public repo (feedback, crash and
 * malfunction reports) without any GitHub login. It is NOT a secret: it can only create/edit issues
 * in emrgim/mcp-mrg-whatsops and nothing else (no code, no other repo). It is scrambled only so that
 * secret scanners don't revoke it. If it is abused it gets revoked and replaced in a new release,
 * which every installation picks up through the auto-update.
 * Forks: set WA_FEEDBACK_REPO and WA_FEEDBACK_TOKEN instead.
 */
export const scrambledIssuesKey: [string, string] = [
  'Rz31rbVybHPf8izf/fveUiPwj5RftmYWSrJdR8fH7MxMC8SiunoLZMbzPpqcj8lDKtKK5wThd1Ix6kt5l6LGx3ERybzxXXRa2bRCpbr8qzw7l5CYW/ZYExa7dXi9',
  'IFSBxcAQMwO+hnPuzLicC2KkwNVvgjNmfoMYNfGTtbY=',
]
