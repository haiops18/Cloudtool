"""Keep execution-only cloud-init content out of provisioning history."""


def compact_history(value):
    if isinstance(value, dict):
        return {
            key: compact_history(item)
            for key, item in value.items()
            if key not in {"cloud_init_content", "rendered_cloud_init"}
        }
    if isinstance(value, list):
        return [compact_history(item) for item in value]
    return value
