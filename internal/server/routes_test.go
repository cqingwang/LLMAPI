package server

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestShouldServeRequestSharePageUsesCookieBeforeAccept(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name     string
		cookie   string
		accept   string
		wantHTML bool
	}{
		{
			name:     "browser session cookie is detected",
			cookie:   "axonhub_browser_session=1",
			accept:   "application/json",
			wantHTML: true,
		},
		{
			name:     "no cookie is treated as shared url",
			accept:   "text/html,application/xhtml+xml",
			wantHTML: false,
		},
		{
			name:     "invalid value remains subject to jwt validation",
			cookie:   "axonhub_browser_session=unexpected",
			accept:   "text/html",
			wantHTML: true,
		},
		{
			name:     "unrelated cookie is treated as shared url",
			cookie:   "sidebar_state=true",
			accept:   "text/html",
			wantHTML: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/project/requests/gid%3A%2F%2Faxonhub%2FRequest%2F1?sessionid=token", nil)
			if test.cookie != "" {
				req.Header.Set("Cookie", test.cookie)
			}
			req.Header.Set("Accept", test.accept)
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = req

			cookie, ok := browserSessionCookie(ctx)
			require.Equal(t, test.wantHTML, ok && cookie != "")
		})
	}
}
