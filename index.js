const { Client, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, PermissionsBitField, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder, SlashCommandBuilder, REST, Routes, ChannelType, ApplicationCommandOptionType } = require('discord.js');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const client = new Client({
    intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildModeration,
        ],
    partials: [Partials.Channel, Partials.GuildMember],
});

const ACCENT = 0x9b1a1a;
const CYAN   = 0x00e5ff;

// Role IDs
const STAFF_ROLES = ['Owner', 'Admin', 'Moderator', 'Support Staff'];

// Warn storage (in-memory, resets on restart - good enough for a small server)
const warns = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isStaff(member) {
    return member.id === member.guild.ownerId ||
           member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.roles.cache.some(r => STAFF_ROLES.includes(r.name));
}

function isTicketChannel(channel) {
    // Ticket Tool names tickets: ticket-0001, ticket-0002, etc.
  return /^ticket-\d+$/i.test(channel.name) || channel.name.toLowerCase().startsWith('ticket-');
}

function embed(color, desc, title) {
    const e = new EmbedBuilder().setColor(color);
    if (title) e.setTitle(title);
    if (desc)  e.setDescription(desc);
    return e;
}

function staffEmbed(desc, title) { return embed(ACCENT, desc, title); }
function infoEmbed(desc, title)  { return embed(CYAN,   desc, title); }
function errEmbed(desc)          { return embed(0xff4444, desc); }
function okEmbed(desc)           { return embed(0x00cc66, desc); }

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const follow = (u) => {
            https.get(u, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return follow(res.headers.location);
                if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

const OWNER_ID = '947783551938592828';

function getAssignableRoles(guild) {
    const botMember = guild.members.me;
    if (!botMember) return [];
    const botTop = botMember.roles.highest.position;
    return Array.from(
        guild.roles.cache
            .filter(r => r.id !== guild.id && !r.managed && r.position < botTop)
            .sort((a, b) => b.position - a.position)
            .values()
    );
}

function buildRolesPayload(guild, targetMember) {
    const rolesArr = getAssignableRoles(guild);
    const MAX_OPTS = 25;
    const MAX_MENUS = 5;
    const MAX_TOTAL = MAX_OPTS * MAX_MENUS;
    const shown = rolesArr.slice(0, MAX_TOTAL);
    const overflow = Math.max(0, rolesArr.length - MAX_TOTAL);

    const components = [];
    for (let i = 0; i < shown.length; i += MAX_OPTS) {
        const chunk = shown.slice(i, i + MAX_OPTS);
        const chunkIdx = components.length;
        const options = chunk.map(r => ({
            label: r.name.slice(0, 100),
            value: r.id,
            default: targetMember.roles.cache.has(r.id),
        }));
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`roles:${chunkIdx}:${targetMember.id}`)
            .setPlaceholder(`Roles ${i + 1}–${i + chunk.length}`)
            .setMinValues(0)
            .setMaxValues(chunk.length)
            .addOptions(options);
        components.push(new ActionRowBuilder().addComponents(menu));
    }

    const heldCount = targetMember.roles.cache.filter(r => r.id !== guild.id).size;
    const desc =
        `🎭 **Target:** ${targetMember}\n` +
        `**Assignable roles:** ${rolesArr.length}\n` +
        `**Currently held (excl. @everyone):** ${heldCount}\n\n` +
        'Each dropdown chunk syncs independently on submit: selected = kept/added, deselected = removed.' +
        (overflow ? `\n\n⚠️ Showing the first ${MAX_TOTAL} of ${rolesArr.length} — ${overflow} role(s) not displayed (Discord cap).` : '');

    const e = infoEmbed(desc, '🎭 Role Selector');
    e.setFooter({ text: 'Menus expire after 5 minutes.' });
    return { embed: e, components, roleCount: rolesArr.length };
}

async function applyRoleSync(interaction) {
    const parts = interaction.customId.split(':');
    const targetId = parts[2];
    const guild = interaction.guild;
    let targetMember;
    try {
        targetMember = await guild.members.fetch(targetId);
    } catch {
        return interaction.reply({ embeds: [errEmbed('❌ Target user is no longer in this guild.')], ephemeral: true });
    }

    const chunkRoleIds = interaction.component.options.map(o => o.value);
    const selected = new Set(interaction.values);

    const toAdd = [];
    const toRemove = [];
    for (const roleId of chunkRoleIds) {
        const role = guild.roles.cache.get(roleId);
        if (!role || !role.editable) continue;
        const has = targetMember.roles.cache.has(roleId);
        const want = selected.has(roleId);
        if (want && !has) toAdd.push(roleId);
        else if (!want && has) toRemove.push(roleId);
    }

    if (!toAdd.length && !toRemove.length) {
        return interaction.reply({ embeds: [infoEmbed('ℹ️ No changes — your selection already matches current state.')], ephemeral: true });
    }

    try {
        if (toAdd.length) await targetMember.roles.add(toAdd, `Role selector (${interaction.user.tag})`);
        if (toRemove.length) await targetMember.roles.remove(toRemove, `Role selector (${interaction.user.tag})`);
    } catch (e) {
        return interaction.reply({ embeds: [errEmbed(`❌ Failed to update roles: ${e.message}`)], ephemeral: true });
    }

    const fmt = ids => ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '_none_';
    return interaction.reply({
        embeds: [okEmbed(`✅ Synced.\n**Added:** ${fmt(toAdd)}\n**Removed:** ${fmt(toRemove)}`)],
        ephemeral: true,
    });
}

// ── Slash Command Definitions ─────────────────────────────────────────────────
const slashCommands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency and WebSocket ping'),
    new SlashCommandBuilder().setName('help').setDescription('View all bot commands with an interactive menu'),
    new SlashCommandBuilder().setName('info').setDescription('View server statistics'),
    new SlashCommandBuilder().setName('userinfo').setDescription('View detailed user profile')
        .addUserOption(o => o.setName('user').setDescription('The user to look up (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('status').setDescription('View bot & server status — uptime, ping, tickets'),
    new SlashCommandBuilder().setName('rules').setDescription('Display the server rules'),
    new SlashCommandBuilder().setName('ticket').setDescription('View your open tickets'),
    new SlashCommandBuilder().setName('queue').setDescription('See how many tickets are open'),
    new SlashCommandBuilder().setName('ticketinfo').setDescription('View info about the current ticket (use inside a ticket channel)'),
    new SlashCommandBuilder().setName('adduser').setDescription('Add a user to the current ticket')
        .addUserOption(o => o.setName('user').setDescription('The user to add to this ticket').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close the current ticket')
        .addStringOption(o => o.setName('reason').setDescription('Reason for closing the ticket').setRequired(false)),
    new SlashCommandBuilder().setName('say').setDescription('Send a message as the bot')
        .addStringOption(o => o.setName('message').setDescription('The message to send').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to send in (default: current)').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('clear').setDescription('Delete messages in this channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete').setRequired(true)
            .addChoices({ name: '10 messages', value: 10 }, { name: '25 messages', value: 25 }, { name: '50 messages', value: 50 }, { name: '100 messages', value: 100 }))
        .addStringOption(o => o.setName('filter').setDescription('Filter messages by type').setRequired(true)
            .addChoices({ name: 'All messages', value: 'all' }, { name: 'Specific user', value: 'user' }, { name: 'Bots only', value: 'bots' }))
        .addUserOption(o => o.setName('user').setDescription('User to filter by (only when filter = Specific user)').setRequired(false)),
    new SlashCommandBuilder().setName('purge').setDescription('Quick bulk-delete messages')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to kick').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to ban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(false)),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
        .addUserOption(o => o.setName('user').setDescription('The member to warn').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false)),
    new SlashCommandBuilder().setName('warns').setDescription('View warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to check (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to clear warnings for').setRequired(true)),
    new SlashCommandBuilder().setName('steal').setDescription('Steal emojis to this server or download them')
        .addStringOption(o => o.setName('emojis').setDescription('Paste emojis here (up to 5, separated by spaces)').setRequired(true)),
    new SlashCommandBuilder().setName('stealsticker').setDescription('Steal a sticker — reply to a sticker message first, then use this command')
        .addStringOption(o => o.setName('name').setDescription('Custom name for the sticker').setRequired(false)),
    new SlashCommandBuilder().setName('changeformat').setDescription('Convert an image or video file to a different format')
        .addAttachmentOption(o => o.setName('file').setDescription('The image or video file to convert').setRequired(true)),
    new SlashCommandBuilder().setName('roles').setDescription('Interactive role selector')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: yourself)').setRequired(false)),
];

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`[RazorReaper] Online as ${client.user.tag}`);
    console.log(`[RazorReaper] Connected to ${client.guilds.cache.size} server(s):`);
    client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id})`));
    client.user.setPresence({
          activities: [{ name: 'rr.sellhub.cx | /help', type: ActivityType.Watching }],
          status: 'online',
    });

    // Register slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        console.log('[RazorReaper] Registering slash commands...');
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: slashCommands.map(c => c.toJSON()),
        });
        console.log('[RazorReaper] Slash commands registered globally!');
    } catch (err) {
        console.error('[RazorReaper] Failed to register slash commands:', err);
    }

    // Set bot bio + banner
    try {
        const path = require('path');
        const bannerPath = path.join(__dirname, 'banner.png');
        const bannerData = fs.readFileSync(bannerPath);
        const bannerBase64 = `data:image/png;base64,${bannerData.toString('base64')}`;
        await client.rest.patch('/users/@me', {
            body: {
                bio: '⚡ Official RazorReaper bot — ticket management, server info & moderation. Visit rr.sellhub.cx',
                banner: bannerBase64,
            },
        });
        console.log('[RazorReaper] Banner & bio set!');
    } catch (err) {
        console.error('[RazorReaper] Failed to set banner/bio:', err.message || err);
    }
});

// ── Welcome new members ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
    const ch = member.guild.channels.cache.find(c => c.name.includes('welcome'));
    if (!ch) return;
    const e = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle('⚡ Welcome to RazorReaper!')
      .setDescription(
              `Hey ${member}, welcome to the community!\n\n` +
              `📋 Read the rules in <#${member.guild.channels.cache.find(c=>c.name.includes('rules'))?.id || 'rules'}>\n` +
              `🎟️ Need help? Open a ticket in create-ticket\n` +
              `🌐 Visit us at **rr.sellhub.cx**`
            )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `Member #${member.guild.memberCount}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    ch.send({ embeds: [e] });
});

// ── Message Commands ──────────────────────────────────────────────────────────
// ── Slash Command Handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, channel } = interaction;

    // ── /ping ─────────────────────────────────────────────────────────────────
    if (commandName === 'ping') {
        const sent = await interaction.reply({ embeds: [infoEmbed('⏱️ Pinging...')], fetchReply: true });
        const ms = sent.createdTimestamp - interaction.createdTimestamp;
        return sent.edit({ embeds: [infoEmbed(`⚡ Pong! \`${ms}ms\` | WS: \`${client.ws.ping}ms\``)] });
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    if (commandName === 'help') {
        const isS = isStaff(member);
        const helpCategories = {
            home: () => new EmbedBuilder()
                .setColor(ACCENT)
                .setTitle('⚡ RazorReaper Bot')
                .setDescription(
                    'Welcome to the **RazorReaper** help menu!\n\n' +
                    'Use the dropdown below to browse command categories.\n\n' +
                    '**Slash Commands:** `/command`\n' +
                    '**Website:** [rr.sellhub.cx](https://rr.sellhub.cx)'
                )
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields({ name: '📂 Categories', value:
                    '🎟️ **Tickets** — Manage support tickets\n' +
                    '📊 **Server** — Server info & utilities\n' +
                    '😎 **Emoji** — Steal emojis & stickers\n' +
                    (isS ? '🛡️ **Admin** — Channel management & tools\n🔨 **Staff** — Moderation & member management\n' : '')
                })
                .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() })
                .setTimestamp(),
            tickets: () => new EmbedBuilder()
                .setColor(ACCENT).setTitle('🎟️ Ticket Commands')
                .setDescription('Manage and interact with the ticket system.')
                .addFields(
                    { name: '`/ticket`', value: 'View your open ticket(s)' },
                    { name: '`/queue`', value: 'See how many tickets are open' },
                    { name: '`/ticketinfo`', value: 'Info about current ticket *(use inside a ticket channel)*' },
                    { name: '`/adduser` `user`', value: 'Add someone to current ticket *(use inside a ticket channel)*' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            server: () => new EmbedBuilder()
                .setColor(CYAN).setTitle('📊 Server Commands')
                .setDescription('View server info and utilities.')
                .addFields(
                    { name: '`/info`', value: 'Server statistics — members, boosts, creation date and more' },
                    { name: '`/userinfo` `[user]`', value: 'Detailed user profile — roles, join date, account age' },
                    { name: '`/status`', value: 'Bot & server status — uptime, ping, open tickets' },
                    { name: '`/rules`', value: 'Display the server rules' },
                    { name: '`/ping`', value: 'Check bot latency and WebSocket ping' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            emoji: () => new EmbedBuilder()
                .setColor(0xffcc00).setTitle('😎 Emoji & Sticker Commands')
                .setDescription('Steal emojis and stickers from other servers!')
                .addFields(
                    { name: '`/steal` `emojis`', value: 'Paste emojis into the input field — shows **Steal / Download / Both** buttons' },
                    { name: '`/stealsticker` `[name]`', value: 'Reply to a sticker message first, then run this command' },
                ).setFooter({ text: 'Requires Manage Expressions permission', iconURL: client.user.displayAvatarURL() }),
            admin: () => new EmbedBuilder()
                .setColor(0x9b59b6).setTitle('🛡️ Admin Commands')
                .setDescription('Channel management and administrative tools. Staff only.')
                .addFields(
                    { name: '`/clear` `amount` `filter` `[user]`', value: 'Delete messages — pick amount, filter type, and optionally a specific user' },
                    { name: '`/purge` `amount`', value: 'Quick bulk-delete messages' },
                    { name: '`/say` `message` `[channel]`', value: 'Send an announcement as the bot' },
                    { name: '`/close` `[reason]`', value: 'Close a ticket channel *(use inside a ticket channel)*' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            staff: () => new EmbedBuilder()
                .setColor(0xff4444).setTitle('🔨 Staff Commands')
                .setDescription('Member moderation and management. Staff only.')
                .addFields(
                    { name: '`/kick` `user` `[reason]`', value: 'Kick a member from the server' },
                    { name: '`/ban` `user` `[reason]`', value: 'Ban a member from the server' },
                    { name: '`/warn` `user` `[reason]`', value: 'Issue a warning — member gets a DM' },
                    { name: '`/warns` `[user]`', value: 'View all warnings for a member' },
                    { name: '`/clearwarns` `user`', value: 'Clear all warnings for a member' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
        };

        const options = [
            { label: 'Home', description: 'Main help overview', value: 'home', emoji: '⚡' },
            { label: 'Tickets', description: 'Ticket system commands', value: 'tickets', emoji: '🎟️' },
            { label: 'Server', description: 'Server info & utilities', value: 'server', emoji: '📊' },
            { label: 'Emoji & Stickers', description: 'Steal emojis & stickers', value: 'emoji', emoji: '😎' },
        ];
        if (isS) {
            options.push({ label: 'Admin', description: 'Channel management & tools', value: 'admin', emoji: '🛡️' });
            options.push({ label: 'Staff', description: 'Member moderation', value: 'staff', emoji: '🔨' });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`help_slash_${interaction.id}`)
            .setPlaceholder('Select a category...')
            .addOptions(options);

        const reply = await interaction.reply({
            embeds: [helpCategories.home()],
            components: [new ActionRowBuilder().addComponents(selectMenu)],
            fetchReply: true,
        });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 120_000 });
        collector.on('collect', async (i) => { const b = helpCategories[i.values[0]]; if (b) await i.update({ embeds: [b()] }); });
        collector.on('end', () => { reply.edit({ components: [] }).catch(() => {}); });
        return;
    }

    // ── /info ─────────────────────────────────────────────────────────────────
    if (commandName === 'info') {
        await guild.fetch();
        const onlineCount = guild.members.cache.filter(m => m.presence?.status === 'online').size;
        const boostTier = guild.premiumTier === 0 ? 'No boost' : `Tier ${guild.premiumTier}`;
        const e = new EmbedBuilder().setColor(ACCENT).setTitle(`⚙️ ${guild.name}`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
                { name: '🟢 Online', value: `${onlineCount}`, inline: true },
                { name: '🚀 Boost', value: boostTier, inline: true },
                { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: '🌐 Website', value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
            ).setFooter({ text: 'RazorReaper', iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /userinfo ─────────────────────────────────────────────────────────────
    if (commandName === 'userinfo') {
        const target = interaction.options.getMember('user') || member;
        const roles = target.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
        const topRoles = roles.first(5).map(r => r.toString()).join(' ') || 'None';
        const e = new EmbedBuilder().setColor(CYAN).setTitle(`👤 ${target.user.username}`)
            .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { name: '🆔 User ID', value: target.id, inline: true },
                { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: '🗓️ Account Age', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '🏆 Top Role', value: `${target.roles.highest}`, inline: true },
                { name: '🤖 Bot?', value: target.user.bot ? 'Yes' : 'No', inline: true },
                { name: `📋 Roles (${roles.size})`, value: topRoles },
            ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /status ───────────────────────────────────────────────────────────────
    if (commandName === 'status') {
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c)).size;
        const e = infoEmbed(null, '📊 RazorReaper Status');
        e.addFields(
            { name: '🤖 Bot', value: 'Online ✅', inline: true },
            { name: '⏱️ Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
            { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
            { name: '🎟️ Open Tickets', value: `${openTickets}`, inline: true },
            { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
            { name: '🌐 Website', value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /rules ────────────────────────────────────────────────────────────────
    if (commandName === 'rules') {
        const e = new EmbedBuilder().setColor(ACCENT).setTitle('📋 RazorReaper — Server Rules')
            .setDescription(
                '**1.** Be respectful to all members.\n**2.** No spam, advertising or self-promotion.\n' +
                '**3.** No NSFW content.\n**4.** No doxxing or sharing personal info.\n' +
                '**5.** Follow Discord\'s Terms of Service.\n**6.** Use channels for their intended purpose.\n' +
                '**7.** All disputes go through the ticket system — do not DM staff.\n\n*Violations may result in a warn, kick or ban.*'
            ).setFooter({ text: 'RazorReaper | rr.sellhub.cx' });
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticket ───────────────────────────────────────────────────────────────
    if (commandName === 'ticket') {
        const userTickets = guild.channels.cache.filter(c => isTicketChannel(c) && c.permissionOverwrites.cache.has(interaction.user.id));
        if (userTickets.size === 0) {
            const createCh = guild.channels.cache.find(c => c.name.includes('create-ticket'));
            return interaction.reply({ embeds: [infoEmbed(`❌ You have no open tickets.\n\nOpen one in ${createCh ? `<#${createCh.id}>` : 'create-ticket'}!`)], ephemeral: true });
        }
        const list = userTickets.map(c => `• ${c} — \`${c.name}\``).join('\n');
        return interaction.reply({ embeds: [infoEmbed(`🎟️ Your open ticket${userTickets.size > 1 ? 's' : ''}:\n${list}`)], ephemeral: true });
    }

    // ── /queue ────────────────────────────────────────────────────────────────
    if (commandName === 'queue') {
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c));
        const closedTickets = guild.channels.cache.filter(c => c.name.toLowerCase().startsWith('closed-'));
        const e = infoEmbed(null, '🎟️ Ticket Queue');
        e.addFields(
            { name: '🟢 Open Tickets', value: `${openTickets.size}`, inline: true },
            { name: '🔴 Closed Tickets', value: `${closedTickets.size}`, inline: true },
            { name: '📊 Total', value: `${openTickets.size + closedTickets.size}`, inline: true },
        );
        if (isStaff(member) && openTickets.size > 0) {
            e.addFields({ name: '📋 Open Channels', value: openTickets.map(c => `• ${c}`).join('\n').substring(0, 1024) });
        }
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticketinfo ───────────────────────────────────────────────────────────
    if (commandName === 'ticketinfo') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const perms = channel.permissionOverwrites.cache;
        const ticketOwner = perms.filter(p => p.type === 1 && p.id !== guild.id).find(p => p.allow.has(PermissionsBitField.Flags.ViewChannel));
        const ownerUser = ticketOwner ? await client.users.fetch(ticketOwner.id).catch(() => null) : null;
        const e = infoEmbed(null, `🎟️ Ticket Info — #${channel.name}`);
        e.addFields(
            { name: '📛 Channel', value: `${channel}`, inline: true },
            { name: '👤 Owner', value: ownerUser ? `<@${ownerUser.id}>` : 'Unknown', inline: true },
            { name: '📅 Created', value: `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>`, inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /adduser ──────────────────────────────────────────────────────────────
    if (commandName === 'adduser') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        await channel.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.reply({ embeds: [okEmbed(`✅ Added ${target} to this ticket.`)] });
    }

    // ── /close ────────────────────────────────────────────────────────────────
    if (commandName === 'close') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        if (!isStaff(member) && !channel.permissionOverwrites.cache.has(interaction.user.id)) {
            return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        }
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const e = new EmbedBuilder().setColor(0xff4444).setTitle('🔒 Ticket Closing')
            .setDescription(`**Reason:** ${reason}\n\nThis ticket will be closed.`)
            .setFooter({ text: `Closed by ${interaction.user.tag}` }).setTimestamp();
        await interaction.reply({ embeds: [e] });
        const num = channel.name.replace(/[^0-9]/g, '');
        await channel.setName(`closed-${num || '0000'}`).catch(() => {});
        await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false }).catch(() => {});
        return;
    }

    // ── /say ──────────────────────────────────────────────────────────────────
    if (commandName === 'say') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const text = interaction.options.getString('message');
        const targetChannel = interaction.options.getChannel('channel') || channel;
        await targetChannel.send(text);
        return interaction.reply({ embeds: [okEmbed(`✅ Message sent to ${targetChannel}`)], ephemeral: true });
    }

    // ── /clear ────────────────────────────────────────────────────────────────
    if (commandName === 'clear') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const amount = interaction.options.getInteger('amount');
        const filter = interaction.options.getString('filter');
        const targetUser = interaction.options.getUser('user');

        if (filter === 'user' && !targetUser) {
            return interaction.reply({ embeds: [errEmbed('❌ You selected "Specific user" but didn\'t provide a user.\nUse the `user` option.')], ephemeral: true });
        }

        await interaction.reply({ embeds: [infoEmbed('🗑️ Clearing messages...')] });

        let totalDeleted = 0;
        let remaining = amount;

        while (remaining > 0) {
            const fetchAmount = Math.min(remaining, 100);
            const fetched = await channel.messages.fetch({ limit: fetchAmount }).catch(() => null);
            if (!fetched || fetched.size === 0) break;

            let toDelete = fetched;
            if (filter === 'user' && targetUser) toDelete = toDelete.filter(m => m.author.id === targetUser.id);
            else if (filter === 'bots') toDelete = toDelete.filter(m => m.author.bot);

            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            toDelete = toDelete.filter(m => m.createdTimestamp > twoWeeksAgo);

            if (toDelete.size === 0) break;
            const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
            if (!deleted || deleted.size === 0) break;

            totalDeleted += deleted.size;
            remaining -= fetchAmount;
            if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
        }

        let desc = `🗑️ Deleted **${totalDeleted}** messages`;
        if (filter === 'user' && targetUser) desc += ` from ${targetUser}`;
        else if (filter === 'bots') desc += ' from bots';
        desc += ' in this channel.';

        const m = await channel.send({ embeds: [okEmbed(desc)] });
        setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
    }

    // ── /purge ────────────────────────────────────────────────────────────────
    if (commandName === 'purge') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const n = interaction.options.getInteger('amount');
        await interaction.reply({ embeds: [infoEmbed('🗑️ Purging...')], ephemeral: true });
        const deleted = await channel.bulkDelete(n, true).catch(() => null);
        if (!deleted) return interaction.editReply({ embeds: [errEmbed('❌ Cannot delete messages older than 14 days.')] });
        const m = await channel.send({ embeds: [okEmbed(`🗑️ Deleted **${deleted.size}** messages.`)] });
        setTimeout(() => m.delete().catch(() => {}), 3000);
        return;
    }

    // ── /kick ─────────────────────────────────────────────────────────────────
    if (commandName === 'kick') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.kickable) return interaction.reply({ embeds: [errEmbed('❌ Cannot kick this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.kick(reason);
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was kicked.\n**Reason:** ${reason}`, '👢 Member Kicked')] });
    }

    // ── /ban ──────────────────────────────────────────────────────────────────
    if (commandName === 'ban') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.bannable) return interaction.reply({ embeds: [errEmbed('❌ Cannot ban this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.ban({ reason, deleteMessageSeconds: 86400 });
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was banned.\n**Reason:** ${reason}`, '🔨 Member Banned')] });
    }

    // ── /warn ─────────────────────────────────────────────────────────────────
    if (commandName === 'warn') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const warnKey = `${guild.id}:${target.id}`;
        if (!warns[warnKey]) warns[warnKey] = [];
        warns[warnKey].push({ reason, mod: interaction.user.tag, time: Date.now() });
        const count = warns[warnKey].length;
        target.send({ embeds: [infoEmbed(`⚠️ You received a warning in **${guild.name}**\n**Reason:** ${reason}\n**Total Warnings:** ${count}`)] }).catch(() => {});
        return interaction.reply({ embeds: [staffEmbed(`⚠️ **${target.user.tag}** has been warned.\n**Reason:** ${reason}\n**Total Warnings:** ${count}`, '⚠️ Member Warned')] });
    }

    // ── /warns ────────────────────────────────────────────────────────────────
    if (commandName === 'warns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user') || member;
        const userWarns = warns[`${guild.id}:${target.id}`] || [];
        if (userWarns.length === 0) return interaction.reply({ embeds: [infoEmbed(`✅ **${target.user.tag}** has no warnings.`)] });
        const list = userWarns.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.mod}* — <t:${Math.floor(w.time / 1000)}:R>`).join('\n');
        return interaction.reply({ embeds: [staffEmbed(list, `⚠️ Warnings for ${target.user.tag} (${userWarns.length})`)] });
    }

    // ── /clearwarns ───────────────────────────────────────────────────────────
    if (commandName === 'clearwarns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        warns[`${guild.id}:${target.id}`] = [];
        return interaction.reply({ embeds: [okEmbed(`✅ Cleared all warnings for **${target.user.tag}**.`)] });
    }

    // ── /steal ────────────────────────────────────────────────────────────────
    if (commandName === 'steal') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        const input = interaction.options.getString('emojis');
        const emojiRegex = /<(a?):(\w+):(\d+)>/g;
        const found = [];

        for (const match of input.matchAll(emojiRegex)) {
            found.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
        }

        // Check if it's a raw ID
        if (found.length === 0 && /^\d+$/.test(input.trim())) {
            found.push({ animated: false, name: 'stolen_emoji', id: input.trim(), tryGif: true });
        }

        if (found.length === 0) {
            return interaction.reply({ embeds: [errEmbed('❌ No custom emojis found in your input.\nPaste Discord custom emojis like `:emoji:` into the field.')], ephemeral: true });
        }

        const emojiList = found.map((e, i) => `**${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`).join('\n');

        const previewEmbed = new EmbedBuilder()
            .setColor(CYAN).setTitle('😎 Emoji Stealer — Select & Choose')
            .setDescription(`Found **${found.length}** emoji(s):\n\n${emojiList}`)
            .setFooter({ text: 'Select emojis below, then choose to steal or download. Expires in 60s.' }).setTimestamp();

        const components = [];
        if (found.length > 1) {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`steal_slash_select_${interaction.id}`)
                .setPlaceholder('Select emojis to steal/download...')
                .setMinValues(1).setMaxValues(found.length)
                .addOptions(found.map((e, i) => ({
                    label: `:${e.name}:`, description: e.animated ? 'Animated emoji' : 'Static emoji',
                    value: String(i), emoji: { id: e.id, animated: e.animated },
                })));
            components.push(new ActionRowBuilder().addComponents(selectMenu));
        }

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`steal_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`steal_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`steal_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`steal_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );
        components.push(buttons);

        const reply = await interaction.reply({ embeds: [previewEmbed], components, fetchReply: true });

        let selectedIndices = found.map((_, i) => i);
        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });

        collector.on('collect', async (btnInt) => {
            if (btnInt.customId === `steal_slash_select_${interaction.id}`) {
                selectedIndices = btnInt.values.map(Number);
                const updatedList = found.map((e, i) =>
                    `${selectedIndices.includes(i) ? '✅' : '⬜'} **${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`
                ).join('\n');
                previewEmbed.setDescription(`Found **${found.length}** emoji(s) — **${selectedIndices.length}** selected:\n\n${updatedList}`);
                return btnInt.update({ embeds: [previewEmbed] });
            }
            if (btnInt.customId === `steal_slash_cancel_${interaction.id}`) {
                collector.stop('cancelled');
                return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] });
            }

            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate();
            collector.stop('acted');

            const selected = selectedIndices.map(i => found[i]);
            const results = [];
            const attachments = [];

            for (const emoji of selected) {
                const ext = emoji.animated ? 'gif' : 'png';
                let url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
                if (doSteal) {
                    try {
                        const created = await guild.emojis.create({ attachment: url, name: emoji.name });
                        results.push(`✅ ${created} \`:${emoji.name}:\` — added to server`);
                    } catch (e) {
                        if (emoji.tryGif) { url = `https://cdn.discordapp.com/emojis/${emoji.id}.gif`; try { const c = await guild.emojis.create({ attachment: url, name: emoji.name }); results.push(`✅ ${c} \`:${emoji.name}:\` — added`); continue; } catch {} }
                        results.push(`❌ \`:${emoji.name}:\` — ${e.message}`);
                    }
                }
                if (doDownload) {
                    attachments.push(new AttachmentBuilder(url, { name: `${emoji.name}.${ext}` }));
                    results.push(`📥 \`:${emoji.name}:\` — file attached`);
                }
            }

            await reply.edit({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('😎 Emoji Steal — Results').setDescription(results.join('\n')).setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp()],
                components: [], files: attachments,
            });
        });

        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }

    // ── /stealsticker ─────────────────────────────────────────────────────────
    if (commandName === 'stealsticker') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        // Fetch recent messages to find the latest sticker
        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        const stickerMsg = messages?.find(m => m.stickers.size > 0);
        if (!stickerMsg) {
            return interaction.reply({ embeds: [errEmbed('❌ No sticker found in the last 10 messages.\nSend or find a sticker message first, then use this command.')], ephemeral: true });
        }

        const sticker = stickerMsg.stickers.first();
        const stickerName = interaction.options.getString('name') || sticker.name;

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`sticker_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`sticker_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`sticker_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`sticker_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );

        const previewEmbed = new EmbedBuilder().setColor(CYAN).setTitle('🎨 Sticker Stealer')
            .setDescription(`**Sticker:** ${stickerName}\n**Format:** ${sticker.format}`)
            .setThumbnail(sticker.url)
            .setFooter({ text: 'Choose an action below. Expires in 60s.' }).setTimestamp();

        const reply = await interaction.reply({ embeds: [previewEmbed], components: [buttons], fetchReply: true });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });
        collector.on('collect', async (btnInt) => {
            if (btnInt.customId.includes('_cancel_')) { collector.stop('cancelled'); return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] }); }
            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate(); collector.stop('acted');
            const results = []; const files = [];
            if (doSteal) { try { const c = await guild.stickers.create({ file: sticker.url, name: stickerName, tags: '😀' }); results.push(`✅ Added sticker **${c.name}**!`); } catch (e) { results.push(`❌ ${e.message}`); } }
            if (doDownload) { const ext = sticker.format === 'LOTTIE' ? 'json' : 'png'; files.push(new AttachmentBuilder(sticker.url, { name: `${stickerName}.${ext}` })); results.push('📥 File attached!'); }
            await reply.edit({ embeds: [okEmbed(results.join('\n'))], components: [], files });
        });
        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }

    // ── /changeformat ────────────────────────────────────────────────────────
    if (commandName === 'changeformat') {
        const attachment = interaction.options.getAttachment('file');
        const ext = path.extname(attachment.name).toLowerCase().replace('.', '');
        const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'tif'];
        const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v'];

        let fileType;
        if (imageExts.includes(ext)) fileType = 'image';
        else if (videoExts.includes(ext)) fileType = 'video';
        else if (attachment.contentType?.startsWith('image/')) fileType = 'image';
        else if (attachment.contentType?.startsWith('video/')) fileType = 'video';
        else return interaction.reply({ embeds: [errEmbed('❌ Unsupported file type. Please upload an image or video.')], ephemeral: true });

        const normalExt = ext === 'jpeg' ? 'jpg' : ext;
        const imageFormats = ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff'].filter(f => f !== normalExt);
        const videoFormats = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'gif'].filter(f => f !== normalExt);
        const formats = fileType === 'image' ? imageFormats : videoFormats;

        const menu = new StringSelectMenuBuilder()
            .setCustomId('fmt_select')
            .setPlaceholder(`Choose ${fileType} output format…`)
            .addOptions(formats.map(f => ({
                label: f.toUpperCase(),
                value: f,
                description: fileType === 'video' && f === 'gif' ? 'Convert video to animated GIF' : `Convert to .${f}`,
            })));

        const row = new ActionRowBuilder().addComponents(menu);
        const icon = fileType === 'image' ? '🖼️' : '🎬';
        const sizeMB = (attachment.size / 1024 / 1024).toFixed(2);

        const reply = await interaction.reply({
            embeds: [infoEmbed(`${icon} **${fileType.charAt(0).toUpperCase() + fileType.slice(1)} detected:** \`${attachment.name}\` (${sizeMB} MB)\n\nSelect the format you want to convert to:`, '🔄 Format Converter')],
            components: [row],
            fetchReply: true,
        });

        const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 30_000 });

        collector.on('collect', async (menuInt) => {
            const target = menuInt.values[0];
            collector.stop('selected');
            await menuInt.update({ embeds: [infoEmbed(`⏳ Converting \`${attachment.name}\` → \`.${target}\`… please wait.`, '🔄 Converting')], components: [] });

            const tmpDir = os.tmpdir();
            const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const inputPath = path.join(tmpDir, `rr_in_${stamp}.${ext}`);
            const outputPath = path.join(tmpDir, `rr_out_${stamp}.${target}`);
            const outputName = `${path.basename(attachment.name, path.extname(attachment.name))}.${target}`;

            try {
                await downloadFile(attachment.url, inputPath);

                const args = ['-i', inputPath, '-y'];
                if (fileType === 'video' && target === 'gif') args.push('-vf', 'fps=15,scale=480:-1:flags=lanczos', '-loop', '0');
                if (fileType === 'image' && (target === 'jpg' || target === 'jpeg')) args.push('-q:v', '2');
                args.push(outputPath);

                await new Promise((resolve, reject) => {
                    execFile(ffmpegPath, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, _, stderr) => {
                        if (err) reject(new Error(stderr?.split('\n').pop() || err.message));
                        else resolve();
                    });
                });

                const stats = fs.statSync(outputPath);
                const boostTier = interaction.guild?.premiumTier ?? 0;
                const uploadLimit = boostTier >= 3 ? 100 : boostTier >= 2 ? 50 : 25;
                if (stats.size > uploadLimit * 1024 * 1024) return reply.edit({ embeds: [errEmbed(`❌ Output file is ${(stats.size / 1024 / 1024).toFixed(1)} MB — exceeds this server's ${uploadLimit} MB upload limit.`)] });

                const outMB = (stats.size / 1024 / 1024).toFixed(2);
                const file = new AttachmentBuilder(outputPath, { name: outputName });
                await reply.edit({ embeds: [okEmbed(`✅ **Converted!**\n\`${attachment.name}\` → \`${outputName}\`\nSize: ${sizeMB} MB → ${outMB} MB`)], files: [file] });
            } catch (err) {
                const msg = err.message.includes('ENOENT')
                    ? '❌ **ffmpeg binary not found.** Try reinstalling with `npm install ffmpeg-static`.'
                    : `❌ Conversion failed:\n\`\`\`${err.message.slice(0, 200)}\`\`\``;
                await reply.edit({ embeds: [errEmbed(msg)] }).catch(() => {});
            } finally {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            }
        });

        collector.on('end', (_, reason) => {
            if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out — no format selected.')], components: [] }).catch(() => {});
        });
        return;
    }

    // ── /roles (bot owner only — hardcoded ID) ────────────────────────────────
    if (commandName === 'roles') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ embeds: [errEmbed('❌ You are not authorized to use this command.')], ephemeral: true });
        }
        if (!guild) return interaction.reply({ embeds: [errEmbed('❌ This command must be used in a server.')], ephemeral: true });

        const targetUser = interaction.options.getUser('user') || interaction.user;
        let targetMember;
        try {
            targetMember = await guild.members.fetch(targetUser.id);
        } catch {
            return interaction.reply({ embeds: [errEmbed('❌ That user is not in this guild.')], ephemeral: true });
        }
        const { embed: rolesEmbed, components, roleCount } = buildRolesPayload(guild, targetMember);
        if (roleCount === 0) return interaction.reply({ embeds: [errEmbed('❌ No assignable roles — check the bot\'s role hierarchy.')], ephemeral: true });

        const reply = await interaction.reply({ embeds: [rolesEmbed], components, ephemeral: true, fetchReply: true });
        const collector = reply.createMessageComponentCollector({
            filter: (i) => i.user.id === OWNER_ID && i.customId.startsWith('roles:'),
            time: 300_000,
        });
        collector.on('collect', applyRoleSync);
        collector.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
        return;
    }
});

client.login(process.env.TOKEN);
