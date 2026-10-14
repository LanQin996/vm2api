package egress

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestDNSTCPConnectionReuse(t *testing.T) {
	for _, pipelined := range []bool{false, true} {
		name := "sequential"
		if pipelined {
			name = "pipelined_A_and_AAAA"
		}
		t.Run(name, func(t *testing.T) {
			srv, err := New(Config{
				ProxyURL:      "socks5h://127.0.0.1:1",
				ListenTCP:     "127.0.0.1:0",
				DNSEmptyTypes: []uint16{1, 28},
			})
			if err != nil {
				t.Fatal(err)
			}
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := ln.Accept()
				if err == nil {
					srv.handleDNSTCP(context.Background(), conn)
				}
			}()
			client, err := net.Dial("tcp", ln.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(2 * time.Second))
			queries := [][]byte{overrideQuery(t, 1), overrideQuery(t, 28)}
			frames := make([][]byte, len(queries))
			for i, query := range queries {
				binary.BigEndian.PutUint16(query, uint16(100+i))
				frames[i] = make([]byte, 2+len(query))
				binary.BigEndian.PutUint16(frames[i], uint16(len(query)))
				copy(frames[i][2:], query)
			}
			if pipelined {
				if _, err := client.Write(append(frames[0], frames[1]...)); err != nil {
					t.Fatal(err)
				}
			}
			for i, query := range queries {
				if !pipelined {
					if _, err := client.Write(frames[i]); err != nil {
						t.Fatalf("query %d write: %v", i+1, err)
					}
				}
				var hdr [2]byte
				if _, err := io.ReadFull(client, hdr[:]); err != nil {
					t.Fatalf("query %d: expected DNS response on reused connection, got %v", i+1, err)
				}
				reply := make([]byte, binary.BigEndian.Uint16(hdr[:]))
				if _, err := io.ReadFull(client, reply); err != nil {
					t.Fatalf("query %d response body: %v", i+1, err)
				}
				assertEmptyOverride(t, query, reply, dnsmessage.RCodeSuccess)
			}
			_ = client.Close()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("DNS handler did not exit after client closed connection")
			}
		})
	}
}

func TestDNSTCPServFailThenNextQuery(t *testing.T) {
	srv, err := New(Config{
		ProxyURL:      "socks5h://127.0.0.1:1",
		ListenTCP:     "127.0.0.1:0",
		DNSUpstream:   "127.0.0.1:1",
		DNSEmptyTypes: []uint16{1},
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			srv.handleDNSTCP(context.Background(), conn)
		}
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	failed := overrideQuery(t, 28)
	ok := overrideQuery(t, 1)
	binary.BigEndian.PutUint16(failed, 7)
	binary.BigEndian.PutUint16(ok, 8)
	for _, query := range [][]byte{failed, ok} {
		frame := make([]byte, 2+len(query))
		binary.BigEndian.PutUint16(frame, uint16(len(query)))
		copy(frame[2:], query)
		if _, err := client.Write(frame); err != nil {
			t.Fatal(err)
		}
	}
	var hdr [2]byte
	if _, err := io.ReadFull(client, hdr[:]); err != nil {
		t.Fatal(err)
	}
	first := make([]byte, binary.BigEndian.Uint16(hdr[:]))
	if _, err := io.ReadFull(client, first); err != nil {
		t.Fatal(err)
	}
	var servfail dnsmessage.Message
	if err := servfail.Unpack(first); err != nil {
		t.Fatal(err)
	}
	if servfail.ID != 7 || servfail.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("expected SERVFAIL id 7, got id %d rcode %v", servfail.ID, servfail.RCode)
	}
	if _, err := io.ReadFull(client, hdr[:]); err != nil {
		t.Fatalf("query after SERVFAIL: %v", err)
	}
	second := make([]byte, binary.BigEndian.Uint16(hdr[:]))
	if _, err := io.ReadFull(client, second); err != nil {
		t.Fatal(err)
	}
	assertEmptyOverride(t, ok, second, dnsmessage.RCodeSuccess)
}
