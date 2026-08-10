package postgres

import (
	"testing"
	"testing/fstest"
)

func TestLoadMigrationsRejectsInvalidSequence(t *testing.T) {
	tests := []struct {
		name       string
		files      fstest.MapFS
		wantErr    string
		wantCount  int
		wantSecond int64
	}{
		{
			name: "ordered contiguous versions",
			files: fstest.MapFS{
				"000001_first.sql":  {Data: []byte("SELECT 1;\n")},
				"000002_second.sql": {Data: []byte("SELECT 2;\n")},
			},
			wantCount:  2,
			wantSecond: 2,
		},
		{
			name: "malformed filename",
			files: fstest.MapFS{
				"1_first.sql": {Data: []byte("SELECT 1;\n")},
			},
			wantErr: "invalid migration filename",
		},
		{
			name: "version gap",
			files: fstest.MapFS{
				"000001_first.sql": {Data: []byte("SELECT 1;\n")},
				"000003_third.sql": {Data: []byte("SELECT 3;\n")},
			},
			wantErr: "expected version 2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			migrations, err := loadMigrations(tt.files)
			if tt.wantErr != "" {
				if err == nil || !contains(err.Error(), tt.wantErr) {
					t.Fatalf("loadMigrations() error = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("loadMigrations() error = %v", err)
			}
			if len(migrations) != tt.wantCount {
				t.Fatalf("len(loadMigrations()) = %d, want %d", len(migrations), tt.wantCount)
			}
			if migrations[1].version != tt.wantSecond {
				t.Fatalf("second version = %d, want %d", migrations[1].version, tt.wantSecond)
			}
		})
	}
}

func TestLoadMigrationsComputesSHA256(t *testing.T) {
	migrations, err := loadMigrations(fstest.MapFS{
		"000001_first.sql": {Data: []byte("SELECT 1;\n")},
	})
	if err != nil {
		t.Fatalf("loadMigrations() error = %v", err)
	}
	const want = "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd"
	if migrations[0].checksum != want {
		t.Fatalf("checksum = %q, want %q", migrations[0].checksum, want)
	}
}

func contains(value, fragment string) bool {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
