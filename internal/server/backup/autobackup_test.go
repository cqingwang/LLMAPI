package backup

import (
	"context"
	"io/fs"
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/datastorage"
	"github.com/looplj/axonhub/internal/ent/enttest"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/pkg/xcache"
	"github.com/looplj/axonhub/internal/server/biz"
)

func TestBackupService_cleanupDuplicateBackupsKeepsOneBackup(t *testing.T) {
	client := enttest.NewEntClient(t, "sqlite3", "file:autobackup?mode=memory&_fk=1")
	t.Cleanup(func() { client.Close() })

	cacheConfig := xcache.Config{
		Mode: xcache.ModeMemory,
		Memory: xcache.MemoryConfig{
			Expiration:      5 * time.Minute,
			CleanupInterval: 10 * time.Minute,
		},
	}
	systemService := biz.NewSystemService(biz.SystemServiceParams{Ent: client, CacheConfig: cacheConfig})
	dataStorageService := biz.NewDataStorageService(biz.DataStorageServiceParams{
		SystemService: systemService,
		CacheConfig:   cacheConfig,
		Client:        client,
	})
	service := NewBackupService(BackupServiceParams{
		Ent:                client,
		SystemService:      systemService,
		DataStorageService: dataStorageService,
	})

	ctx := authz.WithTestBypass(ent.NewContext(context.Background(), client))
	directory := t.TempDir()
	storage, err := client.DataStorage.Create().
		SetName("backup-storage").
		SetDescription("backup test storage").
		SetType(datastorage.TypeFs).
		SetSettings(&objects.DataStorageSettings{Directory: &directory}).
		SetStatus(datastorage.StatusActive).
		Save(ctx)
	require.NoError(t, err)

	storageFS, err := dataStorageService.GetFileSystem(ctx, storage)
	require.NoError(t, err)
	require.NoError(t, afero.WriteFile(storageFS, backupFilename, []byte("current"), 0o644))
	require.NoError(t, afero.WriteFile(storageFS, "axonhub-backup-2026-09-04_02-00-00.json", []byte("old"), 0o644))
	require.NoError(t, afero.WriteFile(storageFS, "unrelated.json", []byte("keep"), 0o644))

	require.NoError(t, service.cleanupDuplicateBackups(ctx, storage))

	_, err = storageFS.Stat(backupFilename)
	require.NoError(t, err)
	_, err = storageFS.Stat("axonhub-backup-2026-09-04_02-00-00.json")
	require.ErrorIs(t, err, fs.ErrNotExist)
	_, err = storageFS.Stat("unrelated.json")
	require.NoError(t, err)
}
