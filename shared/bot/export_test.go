package bot

// IsAdminForTest exposes the admin table to the external tests.
func IsAdminForTest(b *Bot, room, member string) (bool, error) { return b.st.IsAdmin(room, member) }
