// superchat-bot is the stock bot: the SDK with only the core commands.
package main

import (
	"github.com/canavan-a/super-chat/shared/bot"
	"github.com/canavan-a/super-chat/shared/bot/cli"
	"github.com/canavan-a/super-chat/shared/bot/core"
)

func main() {
	cli.Main(func(b *bot.Bot) { core.Register(b) })
}
