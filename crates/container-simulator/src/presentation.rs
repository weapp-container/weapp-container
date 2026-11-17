//! Development presentation preferences, separate from simulated device metrics.
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::Path,
    time::{Duration, Instant},
};

/// Maintain cadence without accumulating the host poll's rounding error.
pub struct FrameCadence {
    fps: u32,
    next: Instant,
}
impl FrameCadence {
    pub fn new(fps: u32) -> Self {
        Self {
            fps,
            next: Instant::now(),
        }
    }
    pub fn due(&mut self, now: Instant, fps: u32) -> bool {
        if fps != self.fps {
            self.fps = fps;
            self.next = now;
        }
        if now < self.next {
            return false;
        }
        let period = Duration::from_secs_f64(1.0 / f64::from(fps));
        self.next += period;
        if self.next <= now {
            self.next = now + period;
        }
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RenderScale {
    Named(AutoScale),
    Fixed(f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum AutoScale {
    #[serde(rename = "auto")]
    Auto,
}

impl Default for RenderScale {
    fn default() -> Self {
        Self::Named(AutoScale::Auto)
    }
}

impl RenderScale {
    pub fn parse(value: &str) -> Result<Self, String> {
        if value == "auto" {
            return Ok(Self::default());
        }
        let scale = value
            .parse::<f64>()
            .map_err(|_| "render scale must be auto, 1, 1.5, 2, 3 or 4")?;
        let result = Self::Fixed(scale);
        result.effective(1.0)?;
        Ok(result)
    }
    pub fn effective(self, dpr: f64) -> Result<f64, String> {
        match self {
            Self::Named(_) if dpr.is_finite() && dpr > 0.0 && dpr <= 4.0 => Ok(dpr),
            Self::Fixed(value) if [1.0, 1.5, 2.0, 3.0, 4.0].contains(&value) => Ok(value),
            _ => Err("invalid render scale or devicePixelRatio".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct PresentationSettings {
    pub schema_version: u32,
    pub revision: u64,
    pub generation: u64,
    pub logical_width: u32,
    pub logical_height: u32,
    pub render_scale: RenderScale,
    pub effective_scale: f64,
    pub fps: u32,
}

impl Default for PresentationSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 1,
            generation: 1,
            logical_width: 375,
            logical_height: 667,
            render_scale: RenderScale::default(),
            effective_scale: 1.0,
            fps: 60,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationRequest {
    pub revision: u64,
    pub request_id: Option<String>,
    pub logical_width: Option<u32>,
    pub logical_height: Option<u32>,
    pub render_scale: Option<RenderScale>,
    pub fps: Option<u32>,
    pub device_pixel_ratio: Option<f64>,
}

impl PresentationSettings {
    pub fn candidate(&self, request: &PresentationRequest) -> Result<Self, String> {
        if request.revision != self.revision {
            return Err("ERR_PRESENTATION_REVISION: stale presentation revision".into());
        }
        let mut next = self.clone();
        next.logical_width = request.logical_width.unwrap_or(next.logical_width);
        next.logical_height = request.logical_height.unwrap_or(next.logical_height);
        next.render_scale = request.render_scale.unwrap_or(next.render_scale);
        next.fps = request.fps.unwrap_or(next.fps);
        next.effective_scale = next
            .render_scale
            .effective(request.device_pixel_ratio.unwrap_or(self.effective_scale))?;
        next.validate()?;
        next.revision = self.revision.saturating_add(1);
        if next.logical_width != self.logical_width
            || next.logical_height != self.logical_height
            || next.effective_scale != self.effective_scale
        {
            next.generation = self.generation.saturating_add(1);
        }
        Ok(next)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.logical_width == 0
            || self.logical_height == 0
            || ![15, 30, 60, 120].contains(&self.fps)
        {
            return Err("ERR_PRESENTATION_CONFIG: invalid viewport, version or FPS".into());
        }
        self.render_scale.effective(self.effective_scale)?;
        let width = (f64::from(self.logical_width) * self.effective_scale).ceil();
        let height = (f64::from(self.logical_height) * self.effective_scale).ceil();
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width > 4096.0
            || height > 4096.0
            || width * height * 4.0 > 16.0 * 1024.0 * 1024.0
        {
            return Err("ERR_PRESENTATION_BUDGET: physical target exceeds 4096px or 16 MiB".into());
        }
        Ok(())
    }

    /// Only dev uses this file. Never carry session generations between runs.
    pub fn load(project: &Path) -> Result<Self, io::Error> {
        let path = project.join(".weapp-container/presentation.json");
        let mut value: Self = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(error),
        };
        value.revision = 1;
        value.generation = 1;
        value.effective_scale = value
            .render_scale
            .effective(1.0)
            .map_err(io::Error::other)?;
        value.validate().map_err(io::Error::other)?;
        Ok(value)
    }

    pub fn save(&self, project: &Path) -> Result<(), io::Error> {
        let directory = project.join(".weapp-container");
        fs::create_dir_all(&directory)?;
        let temp = directory.join(format!("presentation-{}.tmp", std::process::id()));
        fs::write(&temp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(temp, directory.join("presentation.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cadence_does_not_accumulate_one_millisecond_poll_rounding() {
        let mut clock = FrameCadence::new(60);
        let start = clock.next;
        let frames = (0..1000)
            .filter(|tick| clock.due(start + Duration::from_millis(*tick), 60))
            .count();
        assert_eq!(frames, 60);
        assert!(clock.due(start + Duration::from_secs(2), 30));
        assert!(!clock.due(start + Duration::from_secs(2), 30));
    }
    #[test]
    fn revisions_generations_auto_and_budget_are_distinct() {
        let original = PresentationSettings::default();
        let update = |value| original.candidate(&serde_json::from_value(value).unwrap());
        let scaled = update(json!({"revision":1,"devicePixelRatio":3})).unwrap();
        assert_eq!(scaled.effective_scale, 3.0);
        assert_eq!(scaled.generation, 2);
        let fps = update(json!({"revision":1,"fps":120})).unwrap();
        assert_eq!((fps.revision, fps.generation), (2, 1));
        assert!(update(json!({"revision":0,"fps":30})).is_err());
        assert!(update(json!({"revision":1,"logicalWidth":4096,"renderScale":2})).is_err());
        assert!(update(
            json!({"revision":1,"logicalWidth":2048,"logicalHeight":2049,"renderScale":1})
        )
        .is_err());
        assert!(update(json!({"revision":1,"renderScale":1.25})).is_err());
        assert!(update(json!({"revision":1,"fps":59})).is_err());
        assert_eq!(original, PresentationSettings::default());
    }
    #[test]
    fn persistence_resets_session_counters_and_dpr() {
        let path = std::env::temp_dir().join(format!("presentation-test-{}", std::process::id()));
        let settings = PresentationSettings {
            revision: 20,
            generation: 9,
            effective_scale: 2.0,
            fps: 30,
            ..Default::default()
        };
        settings.save(&path).unwrap();
        let loaded = PresentationSettings::load(&path).unwrap();
        assert_eq!((loaded.revision, loaded.generation, loaded.fps), (1, 1, 30));
        assert_eq!(loaded.effective_scale, 1.0);
        fs::remove_dir_all(path).unwrap();
    }
}
