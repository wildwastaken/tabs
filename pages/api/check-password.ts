import type { NextApiRequest, NextApiResponse } from "next"
import { isEditPasswordValid } from "../../lib/db"

// Lets the UI confirm the edit/delete password before showing edit controls.
// Every edit/delete request is still checked again on its own.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    return res.status(405).json({ error: "Method not allowed" })
  }

  const password = req.body && typeof req.body === "object" ? req.body.password : undefined
  res.setHeader("Cache-Control", "no-store")
  return res.status(200).json({ ok: isEditPasswordValid(password) })
}
