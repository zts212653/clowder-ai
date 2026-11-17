#!/usr/bin/perl
# Short-lived native Git transport. The original inode stays in place while admission is closed.
use strict;
use warnings;
use Socket qw(AF_UNIX SOCK_STREAM sockaddr_un);
use Fcntl qw(F_SETFD FD_CLOEXEC O_WRONLY O_CREAT O_EXCL);
use Errno qw(ESRCH);
use Digest::SHA qw(sha1_hex);
use Encode qw(encode_utf8);
use JSON::PP qw(decode_json encode_json);
use IO::Select;
use IO::Handle;
use POSIX qw(WNOHANG);

my $c = decode_json($ARGV[0]);
my $socket = "$c->{gitDir}/fsmonitor--daemon.ipc";
my $lockpath = "$socket.lock";
my ($actual, $listener, $native, $lock, $tmp, $lockid, $checking, $client);
my ($closed, $qualified, $finished, $cleaned) = (0, 0, 0, 0);
my $tmp_identity;
my @made;
my %made_id;
sub inode {
    my @st = lstat($_[0]);
    return @st ? "$st[0]:$st[1]:$st[4]" : '';
}
sub phase {
    my ($event) = @_;
    $event->{nonce} = $c->{nonce};
    seek($lock, 0, 2) or die "journal seek: $!\n";
    print $lock encode_json($event)."\n" or die "journal write: $!\n";
    $lock->flush or die "journal flush: $!\n";
    $lock->sync or die "journal sync: $!\n";
}
sub close_on_exec { fcntl($_[0], F_SETFD, FD_CLOEXEC) or die "control close-on-exec: $!\n"; }
sub remember { push @made, $_[0]; $made_id{$_[0]} = inode("$tmp/$_[0]"); }
sub cleanup {
    return if $cleaned;
    close $actual if $actual;
    close $native if $native;
    close $listener if $listener;
    for my $pid ($checking, $client) {
        if ($pid && waitpid($pid, WNOHANG) == 0) { kill 'TERM', $pid; waitpid($pid, 0); }
    }
    if ($closed && -e $socket) {
        die "IPC changed; recovery journal retained\n" unless inode($socket) eq $c->{identity};
        # A sealed qualification plus a now-dead native PID is recoverable proof. Keep its
        # original ctime intact for the parent if the native command was interrupted.
        my $keep_sealed = !$finished && $qualified && !kill(0, $c->{monitorPid}) && $! == ESRCH;
        chmod($c->{mode}, $socket) or die "restore IPC permissions: $!\n" unless $keep_sealed;
    }
    if ($tmp_identity) {
        die "changed control directory; preserve $tmp\n" unless inode($tmp) eq $tmp_identity;
        chdir $c->{gitDir} or die "cleanup cwd: $!\n";
        for my $name (@made) {
            next unless -e "$tmp/$name";
            die "changed control $name; preserve $tmp\n" unless inode("$tmp/$name") eq $made_id{$name};
        }
        for my $name (@made) { unlink("$tmp/$name") or die "cleanup control $name: $!\n" if -e "$tmp/$name"; }
        rmdir($tmp) or die "control directory not empty; retain $tmp: $!\n";
    }
    $cleaned = 1;
}
$SIG{ALRM} = sub { die "native admission deadline\n" };
$SIG{TERM} = sub { die "native admission interrupted\n" };
$SIG{INT} = sub { die "native admission interrupted\n" };

my $ok = eval {
    alarm 15;
    open($lock, '+<&=3') or die "inherited startup mutex unavailable: $!\n";
    close_on_exec($lock);
    $lockid = $c->{lockIdentity};
    die "IPC startup mutex changed\n" unless inode($lockpath) eq $lockid;
    die "IPC identity changed before admission\n" unless inode($socket) eq $c->{identity};
    # Explicit ACL grants could bypass mode 000. Unknown ACL state cannot close admission.
    open(my $acl, '-|', '/bin/ls', '-lde', $socket) or die "IPC ACL observations unavailable\n";
    my @acl = <$acl>;
    close $acl or die "IPC ACL observations failed\n";
    die "IPC ACL scope unknown\n" unless @acl == 1 && $acl[0] =~ /^s[\w-]{9}(?:\@)?\s/;
    $c->{controlPid} = $$;
    $tmp = $c->{controlPath};
    mkdir($tmp, 0700) or die "control directory: $!\n";
    $tmp_identity = inode($tmp);
    for my $pair (['HEAD', "$c->{entry}{head}\n"], ['commondir', "$c->{common}\n"]) {
        sysopen(my $file, "$tmp/$pair->[0]", O_WRONLY|O_CREAT|O_EXCL, 0600) or die "control metadata: $!\n";
        remember($pair->[0]); print $file $pair->[1] or die $!; close $file or die $!;
    }
    chdir $tmp or die "control directory: $!\n";
    socket($listener, AF_UNIX, SOCK_STREAM, 0) or die "native transport socket: $!\n";
    close_on_exec($listener);
    bind($listener, sockaddr_un('fsmonitor--daemon.ipc')) or die "native transport bind: $!\n";
    remember('fsmonitor--daemon.ipc');
    # Keep both native Darwin routing variants inside this private transport, including
    # the remote-FS fallback. Never let the control command choose $HOME or another endpoint.
    my $remote = '.git-fsmonitor-'.sha1_hex(encode_utf8($c->{entry}{path}));
    link('fsmonitor--daemon.ipc', $remote) or die "private remote transport alias: $!\n";
    remember($remote);
    listen($listener, 1) or die "native transport listen: $!\n";
    phase({ phase => 'control', pid => $$, path => $tmp, identity => inode($tmp),
        files => [map { { name => $_, identity => inode("$tmp/$_") } } @made] });
    chdir $c->{gitDir} or die "IPC directory: $!\n";
    socket($actual, AF_UNIX, SOCK_STREAM, 0) or die "control socket: $!\n";
    close_on_exec($actual);
    connect($actual, sockaddr_un('fsmonitor--daemon.ipc')) or die "control connect: $!\n";
    my $peer = getsockopt($actual, 0, 2);
    die "native peer changed\n" unless defined($peer) && length($peer) == 4 && unpack('i', $peer) == $c->{monitorPid};
    die "IPC changed before closing admission\n" unless inode($socket) eq $c->{identity};
    chmod(0000, $socket) or die "close IPC admission: $!\n";
    $closed = 1;
    die "IPC changed while closing admission\n" unless inode($socket) eq $c->{identity};

    $checking = fork(); defined($checking) or die "validator fork: $!\n";
    if (!$checking) { exec($c->{node}, $c->{validator}, encode_json($c)); exit 120; }
    waitpid($checking, 0); my $check = $?; $checking = undef;
    die "closed-admission consumer validation refused\n" if $check;
    seek($lock, 0, 0) or die "qualification seek: $!\n";
    my $witness = 0;
    while (my $line = <$lock>) {
        my $row = decode_json($line);
        $witness = 1 if ($row->{phase} // '') eq 'qualified' && ($row->{nonce} // '') eq $c->{nonce} &&
            ($row->{attempt} // '') eq $c->{attempt} && ($row->{identity} // '') eq $c->{identity};
    }
    die "positive qualification witness missing\n" unless $witness;
    $qualified = 1;
    die "IPC changed after closed validation\n" unless inode($socket) eq $c->{identity};
    die "IPC startup mutex changed after validation\n" unless inode($lockpath) eq $lockid;
    die "owner invocation exited\n" unless getppid() == $c->{finishPid};

    # A temporary repository context selects this private transport path. Its common objects,
    # worktree and official stop command are unchanged; no repository/worktree is registered.
    chdir $tmp or die "control directory: $!\n";
    $client = fork(); defined($client) or die "native stop fork: $!\n";
    if (!$client) {
        exec('git', '-c', 'core.fsmonitor=false', '-c', "fsmonitor.socketDir=$tmp", "--git-dir=$tmp", "--work-tree=$c->{entry}{path}", 'fsmonitor--daemon', 'stop');
        exit 120;
    }
    phase({ phase => 'native-client', pid => $client });
    my $incoming = IO::Select->new($listener);
    until ($incoming->can_read(1)) {
        if (waitpid($client, WNOHANG) == $client) { $client = undef; die "native stop exited before connecting\n"; }
    }
    accept($native, $listener) or die "native transport accept: $!\n";
    close_on_exec($native);
    my $clientpeer = getsockopt($native, 0, 2);
    die "unproven native control client\n" unless defined($clientpeer) && length($clientpeer) == 4 && unpack('i', $clientpeer) == $client;
    close $listener; $listener = undef;
    # Relay the official client's bytes, never synthesize an application request.
    my $select = IO::Select->new($actual, $native);
    while ($select->count) {
        for my $from ($select->can_read(1)) {
            my $to = fileno($from) == fileno($actual) ? $native : $actual;
            my $n = sysread($from, my $buffer, 8192);
            die "native transport read: $!\n" unless defined($n);
            if (!$n) { $select->remove($from); shutdown($to, 1); next; }
            my $offset = 0;
            while ($offset < $n) {
                my $sent = syswrite($to, $buffer, $n - $offset, $offset);
                die "native transport write: $!\n" unless $sent;
                $offset += $sent;
            }
        }
    }
    waitpid($client, 0); my $status = $?; $client = undef;
    die "native stop failed\n" if $status;
    # The private proxy is already closed. Wait for the proven daemon, rather than mistaking
    # that private-path refusal for the original daemon's exit.
    while (kill(0, $c->{monitorPid})) { select(undef, undef, undef, 0.01); }
    die "native exit observations unknown\n" unless $! == ESRCH;
    phase({ phase => 'stopped', identity => $c->{identity} });
    $finished = 1;
    cleanup(); alarm 0;
    print encode_json({ stopped => JSON::PP::true });
    1;
};
my $error = $@;
unless ($ok) {
    alarm 0;
    eval { cleanup(); 1 } or $error .= $@;
    print STDERR $error;
    exit 1;
}
