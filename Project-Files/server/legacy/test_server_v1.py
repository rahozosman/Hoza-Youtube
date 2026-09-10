import unittest

from server import build_qualities, detect_source, detect_youtube


class YouTubeUrlTests(unittest.TestCase):
    def test_video_urls(self):
        self.assertEqual(
            detect_youtube("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            (True, "dQw4w9WgXcQ", "video"),
        )
        self.assertEqual(
            detect_youtube("youtu.be/dQw4w9WgXcQ"),
            (True, "dQw4w9WgXcQ", "video"),
        )

    def test_non_video_targets_are_not_downloadable(self):
        self.assertEqual(detect_youtube("https://example.com/video.mp4"), (False, None, None))
        self.assertEqual(
            detect_youtube("https://www.youtube.com/playlist?list=PL1234567890")[2],
            "playlist",
        )

    def test_zoom_recording_and_clip_links(self):
        source, url, kind = detect_source("https://us02web.zoom.us/rec/share/example-token")
        self.assertEqual(source, "zoom")
        self.assertEqual(url, "https://us02web.zoom.us/rec/share/example-token")
        self.assertEqual(kind, "recording")
        self.assertEqual(
            detect_source("https://zoom.us/clips/share/example-token")[2],
            "clip",
        )


class FormatTests(unittest.TestCase):
    def test_only_declared_video_heights_are_returned(self):
        qualities = build_qualities({
            "duration": 120,
            "formats": [
                {
                    "format_id": "18",
                    "height": 360,
                    "width": 640,
                    "vcodec": "avc1.42001E",
                    "acodec": "mp4a.40.2",
                    "ext": "mp4",
                    "protocol": "https",
                },
                {
                    "format_id": "137",
                    "height": 1080,
                    "width": 1920,
                    "vcodec": "avc1.640028",
                    "acodec": "none",
                    "ext": "mp4",
                    "protocol": "https",
                },
            ],
        })
        self.assertEqual([quality["height"] for quality in qualities], [1080, 360])
        self.assertTrue(all(quality["kind"] == "video" for quality in qualities))


if __name__ == "__main__":
    unittest.main()
