// Package cli is the command line every bot gets: init, run, join, rooms
// and passwd. A custom bot's main is just
//
//	func main() { cli.Main(func(b *bot.Bot) { core.Register(b); /* its own */ }) }
package cli

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"

	"github.com/canavan-a/super-chat/shared/bot"
)

const usage = `usage: %[1]s <command> [flags]

  init [--phrase] [--name NAME]   make the bot's account (prints its recovery phrase)
  run                             run the bot
  join <invite link>              have the running bot join a room
  rooms                           list the running bot's rooms
  passwd                          change the admin password

Every command takes --data DIR (default $SUPERCHAT_BOT_DATA, else ./bot-data).
The admin password is asked for, or read from $SUPERCHAT_BOT_PASSWORD.
$SUPERCHAT_BOT_ENTROPY_FILE points run at the account secret elsewhere.
`

// Main runs the command line. setup registers the bot's commands and hooks.
func Main(setup func(*bot.Bot)) {
	if err := run(os.Args, setup); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, setup func(*bot.Bot)) error {
	prog := args[0]
	if len(args) < 2 {
		fmt.Fprintf(os.Stderr, usage, prog)
		os.Exit(2)
	}
	cmd := args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	data := fs.String("data", defaultDir(), "the bot's data directory")
	switch cmd {
	case "init":
		phrase := fs.Bool("phrase", false, "restore an account from its recovery phrase (asked for)")
		name := fs.String("name", "", "display name (default: a random first name)")
		_ = fs.Parse(args[2:])
		opt := bot.InitOptions{Name: *name}
		if *phrase {
			p, err := prompt("Recovery phrase: ", false)
			if err != nil {
				return err
			}
			opt.Phrase = p
		}
		pw, err := newPassword()
		if err != nil {
			return err
		}
		opt.Password = pw
		acct, err := bot.Init(*data, opt)
		if err != nil {
			return err
		}
		fmt.Printf("Made the bot's account in %s. Its name is %s.\n", *data, acct.Name)
		if !*phrase {
			fmt.Println("\nIts recovery phrase (write it down; this is the only time it's shown):")
			fmt.Println("\n  " + strings.Join(acct.Phrase, " ") + "\n")
		}
		fmt.Printf("Next: %s run --data %s, then %s join <invite link>.\n", prog, *data, prog)
		return nil

	case "run":
		_ = fs.Parse(args[2:])
		log := slog.New(slog.NewTextHandler(os.Stderr, nil))
		b, err := bot.New(bot.Config{DataDir: *data, EntropyFile: os.Getenv("SUPERCHAT_BOT_ENTROPY_FILE"), Logger: log})
		if err != nil {
			return err
		}
		defer b.Close()
		if setup != nil {
			setup(b)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return b.Run(ctx)

	case "join":
		_ = fs.Parse(args[2:])
		if fs.NArg() != 1 {
			return errors.New("join takes one invite link")
		}
		r, err := bot.ControlJoin(*data, fs.Arg(0))
		if err != nil {
			return err
		}
		fmt.Printf("Joined %s (%d members).\n", roomName(r), len(r.Members))
		return nil

	case "rooms":
		_ = fs.Parse(args[2:])
		rooms, err := bot.ControlRooms(*data)
		if err != nil {
			return err
		}
		for _, r := range rooms {
			fmt.Printf("%s  %-30s %d members  %s\n", r.ID, roomName(r), len(r.Members), r.Server)
		}
		return nil

	case "passwd":
		_ = fs.Parse(args[2:])
		pw, err := newPassword()
		if err != nil {
			return err
		}
		if err := bot.SetPassword(*data, pw); err != nil {
			return err
		}
		fmt.Println("Changed the admin password. Admins already logged in stay logged in.")
		return nil
	}
	fmt.Fprintf(os.Stderr, usage, prog)
	os.Exit(2)
	return nil
}

func defaultDir() string {
	if d := os.Getenv("SUPERCHAT_BOT_DATA"); d != "" {
		return d
	}
	return "bot-data"
}

func roomName(r bot.Room) string {
	if r.Name != "" {
		return r.Name
	}
	var names []string
	for _, m := range r.Members {
		if m.Name != "" {
			names = append(names, m.Name)
		}
	}
	if len(names) > 0 {
		return strings.Join(names, ", ")
	}
	return "a room"
}

func newPassword() (string, error) {
	if pw := os.Getenv("SUPERCHAT_BOT_PASSWORD"); pw != "" {
		return pw, nil
	}
	pw, err := prompt("Admin password: ", true)
	if err != nil {
		return "", err
	}
	again, err := prompt("Again: ", true)
	if err != nil {
		return "", err
	}
	if pw != again {
		return "", errors.New("the passwords don't match")
	}
	if pw == "" {
		return "", errors.New("the admin password can't be empty")
	}
	return pw, nil
}

// stdin is shared, so piped input (a phrase, then a password) isn't lost
// to one prompt's buffer.
var stdin = bufio.NewReader(os.Stdin)

// prompt reads a line from the terminal, without echo when secret.
func prompt(label string, secret bool) (string, error) {
	fmt.Fprint(os.Stderr, label)
	if secret && term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
