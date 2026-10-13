// Command superchat-admin is the operator's view of a superchat database.
// It can't read anything (rooms are ciphertext) and it can't tell who
// anyone is: there are no accounts, only room-scoped pseudonyms. It can
// count, and delete a room outright.
//
//	superchat-admin stats
//	superchat-admin delete-room <room-id>
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"main/database"
	"main/rooms"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	dataDir := os.Getenv("SUPERCHAT_DATA_DIR")
	if dataDir == "" {
		dataDir = ".data"
	}
	dbPath := os.Getenv("SUPERCHAT_DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "superchat.db")
	}
	db, err := database.Connect(dbPath)
	if err != nil {
		fail(err)
	}

	switch os.Args[1] {
	case "stats":
		count := func(table string) int64 {
			var n int64
			db.Table(table).Count(&n)
			return n
		}
		var bytes int64
		db.Raw("SELECT COALESCE(SUM(size), 0) FROM blobs").Scan(&bytes)
		fmt.Printf("rooms        %d\nmemberships  %d (pseudonymous, one per person per room)\nmessages     %d\nblobs        %d (%.1f MB)\nvaults       %d\n",
			count("rooms"), count("members"), count("messages"), count("blobs"), float64(bytes)/(1<<20), count("vaults"))
	case "delete-room":
		if len(os.Args) < 3 {
			usage()
		}
		svc := rooms.NewService(db, filepath.Join(dataDir, "blobs"))
		if err := svc.DeleteRoom(os.Args[2]); err != nil {
			fail(err)
		}
		fmt.Println("deleted room", os.Args[2], "(restart superchat to drop its cached state)")
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: superchat-admin stats | delete-room <room>")
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "superchat-admin:", err)
	os.Exit(1)
}
